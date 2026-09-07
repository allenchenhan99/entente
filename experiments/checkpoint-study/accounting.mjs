import fs from 'node:fs';
import path from 'node:path';

const fields = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
const zero = () => ({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
const valid = u => u && fields.every(k => Number.isSafeInteger(u[k]) && u[k] >= 0) && u.cached_input_tokens <= u.input_tokens;
const equal = (a, b) => fields.every(k => a[k] === b[k]);
const add = (a, b) => fields.forEach(k => { a[k] += b[k]; });

/** Native interactive rollouts bill per-response usage, never cumulative counters per tool call. */
export function accountRollouts(rollouts, expectedActors = []) {
  const requests = new Map(), threads = new Map(), actors = new Map(), issues = [];
  const actorState = () => ({ turns: new Map(), requests: new Set(), incomplete: false });
  for (const actor of expectedActors) actors.set(actor, actorState());
  for (const { actor, events, malformed = 0 } of rollouts) {
    if (!actors.has(actor)) actors.set(actor, actorState());
    const a = actors.get(actor);
    if (malformed) { a.incomplete = true; issues.push(`${actor}: ${malformed} malformed rollout lines`); }
    const thread = events.find(e => e.type === 'token_usage_record')?.payload?.thread_id
      ?? events.find(e => e.type === 'session_meta')?.payload?.id ?? actor;
    let activeTurn;
    for (const [index, e] of events.entries()) {
      const p = e.payload ?? {};
      if (e.type === 'event_msg' && p.type === 'task_started') activeTurn = p.turn_id;
      const turnId = p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id ?? activeTurn;
      const key = `${thread}:${turnId ?? 'unknown'}`;
      const order = Number.isFinite(Date.parse(e.timestamp)) ? Date.parse(e.timestamp) : e.ordinal ?? index;
      const turn = a.turns.get(key) ?? { started: false, completed: false, failed: false, requests: new Set(), counter: -1, output: -1, request: -1 };
      if (e.type === 'event_msg') {
        if (p.type === 'task_started') turn.started = true;
        if (p.type === 'task_complete') turn.completed = true;
        if (['turn_aborted', 'task_aborted', 'error'].includes(p.type)) turn.failed = true;
        if (p.type === 'token_count' && valid(p.info?.total_token_usage)) {
          turn.counter = Math.max(turn.counter, order);
          const t = threads.get(thread) ?? { actor, latest: null, counter: null };
          if (!t.counter || p.info.total_token_usage.input_tokens >= t.counter.input_tokens) t.counter = p.info.total_token_usage;
          threads.set(thread, t);
        }
      }
      if (e.type === 'response_item' && (p.role === 'assistant' || ['custom_tool_call', 'function_call'].includes(p.type))) turn.output = Math.max(turn.output, order);
      if (turn.started || turn.completed || turn.failed || turn.counter >= 0 || turn.output >= 0) a.turns.set(key, turn);
      if (e.type !== 'token_usage_record') continue;
      if (!p.response_id || !p.thread_id || !valid(p.usage)) {
        a.incomplete = true; issues.push(`${actor}: invalid request usage record`); continue;
      }
      const previous = requests.get(p.response_id);
      if (previous && (!equal(previous.usage, p.usage) || previous.actor !== actor || previous.thread !== p.thread_id)) throw new Error(`conflicting response usage: ${p.response_id}`);
      requests.set(p.response_id, { actor, thread: p.thread_id, usage: p.usage });
      a.requests.add(p.response_id);
      if (!p.turn_id) { a.incomplete = true; issues.push(`${actor}: usage missing turn association`); }
      turn.requests.add(p.response_id); turn.request = Math.max(turn.request, order); a.turns.set(key, turn);
      const t = threads.get(p.thread_id) ?? { actor, latest: null, counter: null };
      // Total counters are monotonic within a thread. Choose the largest snapshot across copied files.
      if (valid(p.thread_token_usage) && (!t.latest || p.thread_token_usage.input_tokens >= t.latest.input_tokens)) t.latest = p.thread_token_usage;
      threads.set(p.thread_id, t);
    }
  }
  const known = zero(), perActor = {}, perThread = new Map();
  for (const { actor, thread, usage } of requests.values()) {
    add(known, usage);
    perActor[actor] ??= zero(); add(perActor[actor], usage);
    if (!perThread.has(thread)) perThread.set(thread, zero());
    add(perThread.get(thread), usage);
  }
  for (const [thread, t] of threads) {
    if (!t.latest || !equal(perThread.get(thread) ?? zero(), t.latest) || !t.counter || !equal(perThread.get(thread) ?? zero(), t.counter)) {
      actors.get(t.actor).incomplete = true;
      issues.push(`${t.actor}: request records do not reconcile with cumulative thread usage (${thread})`);
    }
  }
  const incomplete = [...actors].filter(([, a]) => a.incomplete || !a.requests.size || !a.turns.size || [...a.turns.values()].some(t => !t.started || !t.completed || t.failed || !t.requests.size || t.counter < Math.max(t.output, t.request))).map(([actor]) => actor).sort();
  return {
    known_usage: { ...known, uncached_input_tokens: known.input_tokens - known.cached_input_tokens },
    per_actor: perActor, unique_requests: requests.size, usage_complete: actors.size > 0 && incomplete.length === 0,
    incomplete_actors: incomplete, expected_actors: [...new Set(expectedActors)].sort(), issues,
  };
}

export function readRollouts(agentsDir) {
  const out = [];
  // Plugin installation directories can vanish after their parent is listed.
  // Only missing directories are benign; permissions and other I/O errors matter.
  const entries = dir => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const walk = (dir, actor) => {
    for (const entry of entries(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, actor);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
        const events = []; let malformed = 0;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { events.push(JSON.parse(line)); } catch { malformed++; }
        }
        out.push({ actor, file, events, malformed });
      }
    }
  };
  for (const actor of entries(agentsDir)) if (actor.isDirectory()) walk(path.join(agentsDir, actor.name), actor.name);
  return out;
}
