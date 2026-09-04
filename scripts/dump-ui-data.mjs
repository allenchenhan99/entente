/**
 * Refresh the replay embedded in docs/ui-prototype.html.
 *
 *     node scripts/dump-ui-data.mjs [fixture]
 *
 * Reduces every prefix of the fixture through the protocol's own reducer and graph API, so the
 * prototype shows what relayd and the TUI would show — never a hand-written mock. Pane scrollback
 * comes from the daemon's own bootstrap prompt and MCP tool names for the same reason. Requires a
 * built protocol package and relayd (`npm run build`) and Node >= 22.
 *
 * The prototype is the only artifact: this script rewrites its <script id="relay-data"> payload in
 * place and touches nothing else, so the page stays the single file to edit and to open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.argv[2] ?? 'fixtures/events-live-5.jsonl';
const target = path.join(root, 'docs/ui-prototype.html');

const { Event, replay, buildGraph, describe, storyFor, actionsFor, RECIPIENT_TOOLS: R } =
  await import(path.join(root, 'packages/protocol/dist/index.js'));
const { bootstrapPrompt } = await import(path.join(root, 'apps/relayd/dist/launch/prompts.js'));
const { CLAUDE_ALLOWED_TOOLS } = await import(path.join(root, 'apps/relayd/dist/launch/runtimes/claude-code.js'));

const events = fs.readFileSync(path.join(root, fixture), 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => Event.parse(JSON.parse(line)));

/** One frame per event: the graph plus every object's description, actions and story. */
function frame(cursor) {
  const slice = events.slice(0, cursor);
  const state = replay(slice);
  const graph = buildGraph(state);
  const detail = {};
  for (const ref of [...graph.nodes.map((n) => ({ kind: 'node', id: n.id })),
                     ...graph.edges.map((e) => ({ kind: 'edge', id: e.id }))]) {
    detail[`${ref.kind}:${ref.id}`] = {
      d: describe(ref, graph, state),
      a: actionsFor(ref, graph, state),
      s: storyFor(ref, graph, state, slice).slice(-14),
    };
  }
  const mission = Object.values(state.missions)[0];
  return {
    c: cursor,
    mission: mission
      ? { id: mission.mission.id, title: mission.mission.title, status: mission.status,
          repo: mission.mission.repo, integration: mission.mission.integration_check }
      : null,
    metrics: state.metrics,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
      recipient: task.contract.recipient, rk: task.contract.runtime,
      pane: task.agent?.pane_id ?? null, wt: task.worktree?.path ?? null,
      branch: task.worktree?.branch ?? null, v: task.contract.version,
      attempt: task.attempt, goal: task.contract.goal,
    }])),
    graph,
    detail,
  };
}

/* ─────────────────────────── pane buffers ───────────────────────────
 * What each pane of the multiplexer shows. relayd drives an agent pane through MCP, so the pane's
 * scrollback is reconstructible from the log: the argv the runtime actually spawns, the bootstrap
 * prompt this repo generates, and the tool calls the lifecycle mandates in the order the events
 * prove they happened. Every line here comes from an event — nothing is invented, but nothing is a
 * capture either, so the UI labels it as reconstructed until Milestone 3 attaches the real PTY.
 */

/** The prompt relayd hands the agent, rendered by the daemon's own code so it cannot drift. */
function promptFor(contract, spawn) {
  const ac = contract.acceptance_criteria
    .map((c) => `  ${c.id}: ${c.condition} [${c.check.kind}${c.check.run ? `: ${c.check.run}` : ''}]`)
    .join('\n');
  return bootstrapPrompt({
    role: 'recipient',
    taskId: contract.id,
    cwd: spawn.cwd,
    sessionId: spawn.session_id,
    mcpUrl: 'http://127.0.0.1:7420/mcp',
    token: '<per-task bearer token>',
    contractSummary: [
      `goal: ${contract.goal}`,
      `inputs: ${contract.inputs.join(', ')}`,
      `constraints:\n${contract.constraints.map((c) => `  - ${c}`).join('\n')}`,
      `non_goals: ${contract.non_goals.join('; ')}`,
      `scope.allowed_paths: ${contract.scope.allowed_paths.join(', ')}`,
      `acceptance_criteria:\n${ac}`,
    ].join('\n'),
  });
}

function paneBuffers() {
  const out = [];                                        // { seq, pane, k, s }
  const contracts = {};                                  // task id → newest contract
  const spawn = {};
  const push = (seq, pane, k, s) => out.push({ seq, pane, k, s });
  const clock = (ts) => ts.slice(11, 19);

  for (const e of events) {
    const p = e.payload ?? {};
    const task = e.task_id;
    const log = (k, s) => push(e.seq, 'relayd', k, `${clock(e.ts)} ${s}`);

    switch (e.type) {
      case 'mission_created':
        log('ok', `relayd 0.1.0 listening on http://127.0.0.1:7420 · mcp /mcp`);
        log('out', `mission ${p.id} created  "${p.title}"`);
        log('dim', `repo ${p.repo} · integration check \`${p.integration_check}\``);
        break;
      case 'tasks_planned':
        log('out', `plan accepted: ${p.task_ids.join(', ')}`);
        break;
      case 'task_proposed':
        contracts[task] = p.contract;
        log('out', `task ${task} proposed v${p.contract.version} → ${p.contract.recipient} (${p.contract.runtime})`);
        break;
      case 'lint_reported':
        log(p.results.length ? 'warn' : 'dim',
          `lint ${task} v${p.contract_version} → ${p.results.length ? `${p.results.length} finding(s)` : 'clean'}`);
        break;
      case 'worktree_created':
        log('dim', `worktree ${p.branch} at ${p.path}`);
        break;
      case 'agent_spawned': {
        spawn[task] = p;
        log('out', `spawned ${p.runtime} for ${task} in pane ${p.pane_id}`);
        const c = contracts[task];
        const argv = p.runtime === 'claude-code'
          ? ['claude', '--session-id', p.session_id, '--mcp-config',
             `${p.cwd}/../../agents/${task}/mcp.json`, '--dangerously-skip-permissions',
             '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(',')]
          : ['codex', '-C', p.cwd, '-a', 'never', '-s', 'workspace-write'];
        push(e.seq, task, 'cmd', `$ ${argv[0]} ${argv.slice(1).join(' ')}`);
        push(e.seq, task, 'dim', `cwd ${p.cwd}`);
        push(e.seq, task, 'ok', `● relay MCP connected · ${Object.keys(R).length} tools · bearer token per task`);
        push(e.seq, task, 'prompt', promptFor(c, p));
        break;
      }
      case 'clarification_requested':
        push(e.seq, task, 'tool', `⏺ ${R.get_contract}()`);
        push(e.seq, task, 'ret', `⎿ contract v${p.contract_version} · ${contracts[task].acceptance_criteria.length} acceptance criteria · worktree ready`);
        push(e.seq, task, 'tool', `⏺ ${R.respond_to_contract}({ decision: "needs_clarification" })`);
        for (const q of p.response.questions) {
          push(e.seq, task, 'out', `  ${q.id}${q.blocking ? ' [blocking]' : ''}  ${q.text}`);
        }
        push(e.seq, task, 'ret', `⎿ recorded · ${p.response.questions.length} question(s) sent to the human`);
        push(e.seq, task, 'tool', `⏺ ${R.await_contract}({ since_version: ${p.contract_version}, timeout_s: 60 })`);
        push(e.seq, task, 'wait', `⎿ pending — no file is touched while waiting`);
        break;
      case 'clarification_answered':
        log('out', `clarification answered for ${task}: ${p.answers.map((a) => a.question_id).join(', ')}`);
        break;
      case 'contract_revised':
        contracts[task] = p.contract;
        log('out', `contract ${task} → v${p.contract.version}`);
        push(e.seq, task, 'ret', `⎿ revised → v${p.contract.version}`);
        push(e.seq, task, 'tool', `⏺ ${R.get_contract}()`);
        push(e.seq, task, 'ret', `⎿ contract v${p.contract.version}`);
        break;
      case 'task_accepted':
        push(e.seq, task, 'tool', `⏺ ${R.respond_to_contract}({ decision: "accepted" })`);
        for (const line of p.response.interpretation) push(e.seq, task, 'out', `  interpretation  ${line}`);
        for (const line of p.response.assumptions) push(e.seq, task, 'dim', `  assumption  ${line}`);
        for (const line of p.response.risks) push(e.seq, task, 'warn', `  risk  ${line}`);
        push(e.seq, task, 'ret', `⎿ work_started · verification plan accepted for every criterion`);
        break;
      case 'work_started':
        log('dim', `${task} work_started`);
        break;
      case 'progress_reported':
        push(e.seq, task, 'tool', `⏺ ${R.report_progress}(${p.percent != null ? `{ percent: ${p.percent} }` : ''})`);
        push(e.seq, task, 'out', `  ${p.message}`);
        break;
      case 'evidence_submitted':
        push(e.seq, task, 'tool', `⏺ ${R.submit_evidence}({ attempt: ${p.submission.attempt} })`);
        push(e.seq, task, 'out', `  ${p.submission.summary}`);
        for (const [id, c] of Object.entries(p.submission.claimed)) {
          push(e.seq, task, c.status === 'passed' ? 'ok' : 'warn', `  claims ${id} ${c.status} — ${c.note}`);
        }
        push(e.seq, task, 'tool', `⏺ ${R.await_verdict}({ attempt: ${p.submission.attempt}, timeout_s: 60 })`);
        push(e.seq, task, 'wait', `⎿ pending — relayd runs the checks, not the agent`);
        break;
      case 'checks_started':
        log('out', `verify ${task} attempt ${p.attempt} — running contract checks`);
        break;
      case 'check_passed':
        log('ok', `  ${p.criterion_id} passed (${p.result.duration_ms} ms) → ${p.result.output_path}`);
        break;
      case 'check_failed':
        log('err', `  ${p.criterion_id} FAILED → ${p.result?.output_path ?? 'no output'}`);
        break;
      case 'evidence_recorded':
        log('dim', `evidence ${task} attempt ${p.record.attempt}: ${p.record.changed_files.join(', ')}`);
        log(p.record.self_report_mismatch.length ? 'err' : 'dim',
          p.record.self_report_mismatch.length
            ? `  self-report mismatch: ${p.record.self_report_mismatch.join(', ')}`
            : `  no self-report mismatch`);
        break;
      case 'task_verified':
        log('ok', `${task} VERIFIED on attempt ${p.attempt}`);
        push(e.seq, task, 'ret', `⎿ verified`);
        push(e.seq, task, 'ok', `verified — stopping as the lifecycle requires`);
        break;
      case 'task_completed':
        log('dim', `${task} completed`);
        break;
      case 'human_review_recorded':
        log(p.status === 'failed' ? 'err' : 'ok',
          `human review ${task} ${p.criterion_id} ${p.status}${p.observed_failure ? `: ${p.observed_failure}` : ''}`);
        break;
      case 'repair_requested':
        log('warn', `repair ${p.repair.id} requested · failed ${p.repair.failed_criteria.join(', ')} · ${p.repair.remaining_repairs} left in budget`);
        push(e.seq, task, 'ret', `⎿ repair ${p.repair.id} · failed ${p.repair.failed_criteria.join(', ')}`);
        push(e.seq, task, 'warn', `  ${p.repair.observed_failure}`);
        break;
      case 'repair_accepted':
        push(e.seq, task, 'tool', `⏺ ${R.get_contract}()`);
        push(e.seq, task, 'ret', `⎿ repair contract ${p.repair_id} · fix only the failed criteria, leave unchanged_scope alone`);
        break;
      case 'task_blocked':
        push(e.seq, task, 'tool', `⏺ ${R.report_blocker}()`);
        push(e.seq, task, 'warn', `  ${p.reason}`);
        push(e.seq, task, 'tool', `⏺ ${R.await_reply}({ timeout_s: 60 })`);
        push(e.seq, task, 'wait', `⎿ pending — waiting on the human, up to 10 minutes`);
        log('warn', `${task} blocked: ${p.reason.split('. ')[0]}.`);
        break;
      case 'blocker_replied':
        push(e.seq, task, 'ret', `⎿ replied: ${p.message}`);
        break;
      case 'task_unblocked':
        push(e.seq, task, 'dim', `resuming — the reply resolves the blocker without a code change`);
        break;
      case 'integration_started':
        log('out', `integration on ${p.branch} · merge order ${p.order.join(' → ')}`);
        break;
      case 'mission_verified':
        log('ok', `mission verified — integration check passed on the merged branch`);
        break;
      default:
        break;
    }
  }
  return out;
}

const payload = JSON.stringify({
  source: fixture,
  pty: paneBuffers(),
  frames: Array.from({ length: events.length }, (_, i) => frame(i + 1)),
});

// `</script>` inside JSON would end the block early; nothing else needs escaping here.
const safe = payload.replaceAll('</', '<\\/');
const open = '<script id="relay-data" type="application/json">';
const html = fs.readFileSync(target, 'utf8');
const start = html.indexOf(open);
if (start < 0) throw new Error(`${target} has no <script id="relay-data"> block to fill`);
const from = start + open.length;
const to = html.indexOf('</script>', from);
fs.writeFileSync(target, html.slice(0, from) + safe + html.slice(to));

console.log(`${path.relative(root, target)}: ${events.length} frames from ${fixture}`
  + ` (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
