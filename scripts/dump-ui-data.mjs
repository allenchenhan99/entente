/**
 * Refresh the replay embedded in docs/ui-prototype.html.
 *
 *     node scripts/dump-ui-data.mjs [fixture]
 *
 * Reduces every prefix of the fixture through the protocol's own reducer and graph API, so the
 * prototype shows what relayd and the TUI would show — never a hand-written mock. Requires a built
 * protocol package (`npm run build -w @relay/protocol`) and Node >= 22.
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

const { Event, replay, buildGraph, describe, storyFor, actionsFor, narrate } =
  await import(path.join(root, 'packages/protocol/dist/index.js'));

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

/** The agent conversation, rendered from event payloads — the right-hand pane's content. */
function message(event) {
  const p = event.payload ?? {};
  const base = { seq: event.seq, ts: event.ts, task: event.task_id ?? null, kind: event.type };
  const sys = (title, lines = []) => ({ ...base, side: 'system', author: event.actor, title, lines });
  const human = (title, lines = []) => ({ ...base, side: 'human', author: 'you', title, lines });
  const agent = (title, lines = []) =>
    ({ ...base, side: 'agent', author: event.actor.replace('agent:', ''), title, lines });

  switch (event.type) {
    case 'mission_created':
      return sys('Mission created', [p.title, `repo ${p.repo}`, `integration check  ${p.integration_check}`]);
    case 'tasks_planned':
      return sys('Plan accepted', [`${p.task_ids.length} tasks: ${p.task_ids.join(', ')}`]);
    case 'task_proposed':
      return human(`Task contract v${p.contract.version} → ${p.contract.recipient}`, [
        p.contract.goal,
        `${p.contract.acceptance_criteria.length} acceptance criteria · scope ${p.contract.scope.allowed_paths.join(', ')}`,
      ]);
    case 'lint_reported':
      return sys(
        p.results.length ? `Communication-debt lint: ${p.results.length} finding(s)` : 'Communication-debt lint: clean',
        p.results.map((r) => `${r.severity ?? 'error'} ${r.rule ?? r.code ?? ''} ${r.message ?? ''}`.trim()),
      );
    case 'worktree_created':
      return sys('Worktree created', [`${p.branch} → ${p.path}`, `base ${String(p.base).slice(0, 12)}`]);
    case 'agent_spawned':
      return sys(`Spawned ${p.runtime}`, [`pane ${p.pane_id}`, `cwd ${p.cwd}`]);
    case 'clarification_requested':
      return agent('Needs clarification before starting',
        p.response.questions.map((q) => `${q.id}${q.blocking ? ' (blocking)' : ''}  ${q.text}`));
    case 'clarification_answered':
      return human('Answered', p.answers.map((a) => `${a.question_id}  ${a.answer}`));
    case 'contract_revised':
      return sys(`Contract revised to v${p.contract.version}`,
        ['Answers folded into the contract; the agent re-reads it before accepting.']);
    case 'task_accepted':
      return agent(`Accepted contract v${p.contract_version}`, [
        ...p.response.interpretation.map((t) => `interpretation  ${t}`),
        ...p.response.assumptions.map((t) => `assumption  ${t}`),
        ...p.response.risks.map((t) => `risk  ${t}`),
      ]);
    case 'work_started':
      return sys('Work started', []);
    case 'progress_reported':
      return agent(p.percent != null ? `Progress ${p.percent}%` : 'Progress', [p.message]);
    case 'evidence_submitted':
      return agent(`Evidence submitted (attempt ${p.submission.attempt})`, [
        p.submission.summary,
        ...Object.entries(p.submission.claimed).map(([id, c]) => `claims ${id} ${c.status}  ${c.note}`),
      ]);
    case 'checks_started':
      return sys(`Verifying attempt ${p.attempt}`,
        ['relayd runs the contract checks itself; the agent is not asked again.']);
    case 'check_passed':
      return sys(`${p.criterion_id} passed`, [`${p.result.duration_ms} ms · ${p.result.output_path}`]);
    case 'check_failed':
      return sys(`${p.criterion_id} FAILED`, [p.result.output_path ?? '']);
    case 'evidence_recorded':
      return sys('Evidence recorded', [
        `changed  ${p.record.changed_files.join(', ')}`,
        `diff  ${p.record.git_diff_path}`,
        p.record.self_report_mismatch.length
          ? `self-report mismatch  ${p.record.self_report_mismatch.join(', ')}`
          : 'no self-report mismatch',
      ]);
    case 'task_verified':
      return sys(`Task verified on attempt ${p.attempt}`,
        ['Every criterion passed under relayd, not under the agent.']);
    case 'task_completed':
      return sys('Task complete', []);
    case 'human_review_recorded':
      return human(`Human review: ${p.criterion_id} ${p.status}`, [p.observed_failure ?? p.note ?? '']);
    case 'repair_requested':
      return sys(`Repair ${p.repair.id} requested`, [
        `failed  ${p.repair.failed_criteria.join(', ')}`,
        p.repair.requested_correction,
        `${p.repair.remaining_repairs} repair(s) left in budget`,
      ]);
    case 'repair_accepted':
      return agent(`Accepted repair ${p.repair_id}`, ['Scoped to the failed criterion only.']);
    case 'task_blocked':
      return agent('Blocked — asking you', [p.reason]);
    case 'blocker_replied':
      return human('Reply to blocker', [p.message]);
    case 'task_unblocked':
      return sys('Unblocked', []);
    case 'integration_started':
      return sys('Integration started', [`branch ${p.branch}`, `order  ${p.order.join(' → ')}`]);
    case 'mission_verified':
      return sys('Mission verified', ['The integration check passed on the merged branch.']);
    default:
      return sys(event.type.replace(/_/g, ' '), []);
  }
}

const payload = JSON.stringify({
  source: fixture,
  events: events.map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type, task_id: e.task_id ?? null })),
  narration: events.map((e, i) => narrate(e, replay(events.slice(0, i + 1)))),
  transcript: events.map(message),
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
