/**
 * `describe(ref, graph, state)`: static facts about one object — contract facts for edges, role and the
 * three states for agent nodes, counts for the virtual nodes, the item itself for inbox entries.
 */
import type { AcceptanceCriterion, CheckResult, EvidenceRecord } from '../contract.js';
import type { State, TaskView } from '../state.js';
import type { Graph, GraphObjectRef, ObjectDescription } from './types.js';
import { HUMAN, PLANNER, VERIFIER, clip, latestRecord, plural, repairName, sortedMissions, sortedTasks } from './common.js';

const none = (ref: GraphObjectRef): ObjectDescription => ({ title: ref.id, lines: [] });

// --- criteria ------------------------------------------------------------------------------------

function checkText(ac: AcceptanceCriterion): string {
  const c = ac.check;
  if (!c) return 'no check';
  switch (c.kind) {
    case 'command':
      return `command: ${c.run}`;
    case 'file_exists':
      return `file_exists: ${c.path}`;
    case 'llm_judge':
      return c.prompt ? `llm_judge: ${clip(c.prompt)}` : 'llm_judge';
    default:
      return c.kind;
  }
}

/** `AC-1 ✓ command: …`, `AC-2 ✗ command: … — observed`, `AC-3 ⏳ human_review`, `AC-4 · …` (no verdict yet). */
function criterionLine(ac: AcceptanceCriterion, result: CheckResult | undefined, verified: boolean): string {
  const status = result?.status;
  const symbol = verified || status === 'passed' ? '✓' : status === 'failed' || status === 'error' ? '✗' : status === 'pending_human' ? '⏳' : '·';
  const observed = !verified && (status === 'failed' || status === 'error') && result?.observed ? ` — ${clip(result.observed, 200)}` : '';
  return `${ac.id} ${symbol} ${checkText(ac)}${observed}`;
}

function criteriaLines(task: TaskView): string[] {
  const record = latestRecord(task);
  const verified = task.handoff_state === 'verified';
  return task.contract.acceptance_criteria.map((ac) => criterionLine(ac, record?.checks[ac.id], verified));
}

function versionsLine(task: TaskView): string {
  const versions = task.versions.map((v) => `v${v.version}`);
  const chain = versions.length > 1 ? `${versions[0]} → ${versions[versions.length - 1]}` : versions[0] ?? `v${task.contract.version}`;
  const n = task.contract.clarifications.length;
  return `versions: ${chain}${n > 0 ? ` (${plural(n, 'clarification')})` : ''}`;
}

/** `2 passed, 1 failed, 1 pending review` for an evidence record. */
function recordSummary(record: EvidenceRecord): string {
  const counts = new Map<string, number>();
  for (const r of Object.values(record.checks)) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const order: Array<[string, string]> = [['passed', 'passed'], ['failed', 'failed'], ['pending_human', 'pending review'], ['error', 'errored']];
  const parts = order.filter(([k]) => counts.has(k)).map(([k, label]) => `${counts.get(k)} ${label}`);
  const mismatch = record.self_report_mismatch.length > 0 ? ` (self-report mismatch on ${record.self_report_mismatch.join(', ')})` : '';
  return `${parts.length > 0 ? parts.join(', ') : 'no checks'}${mismatch}`;
}

// --- edges ---------------------------------------------------------------------------------------

function describeContract(task: TaskView): ObjectDescription {
  const c = task.contract;
  const lines = [
    c.goal || '(no goal)',
    `scope: ${c.scope.allowed_paths.length > 0 ? c.scope.allowed_paths.join(', ') : 'unbounded'}`,
    `non-goals: ${c.non_goals.length > 0 ? c.non_goals.join(', ') : 'none'}`,
    ...criteriaLines(task),
    versionsLine(task),
  ];
  return { title: `${task.id} v${c.version} (${task.handoff_state})`, lines };
}

function describeEvidence(task: TaskView): ObjectDescription {
  const lines: string[] = task.attempts.map((r) => `attempt ${r.attempt}: ${recordSummary(r)}`);
  for (const r of task.repairs) lines.push(`repair ${repairName(r.id)}: ${r.failed_criteria.join(', ')} — ${clip(r.observed_failure, 200)}`);
  if (task.attempts.length === 0) lines.push(task.attempt > 0 ? `attempt ${task.attempt}: checks running` : 'no evidence yet');
  return { title: `${task.id} evidence #${task.attempt} (${task.handoff_state})`, lines };
}

function describeDependency(state: State, producerId: string, consumerId: string): ObjectDescription {
  const producer = state.tasks[producerId];
  const line = producer ? `${producerId}: ${producer.task_state} (${producer.handoff_state})` : `${producerId}: unknown`;
  return { title: `${consumerId} depends on ${producerId}`, lines: [line] };
}

function describeQuestion(task: TaskView): ObjectDescription {
  return {
    title: `${task.contract.recipient} asks ${plural(task.open_questions.length, 'question')} (v${task.contract.version})`,
    lines: task.open_questions.map((q) => `${q.id}: ${q.text}`),
  };
}

function describeMissionQuestion(state: State, missionId: string | undefined): ObjectDescription {
  const mission = missionId ? state.missions[missionId] : undefined;
  const qs = mission?.open_questions ?? [];
  return { title: `planner asks you ${plural(qs.length, 'question')}`, lines: qs.map((q) => `${q.id}: ${q.text}`) };
}

function describeReply(task: TaskView): ObjectDescription {
  const answers = task.contract.clarifications.map((c) => `${c.question_id}: ${clip(c.answer, 200)}`);
  const replies = (task.replies ?? []).map((r) => `${r.at.slice(11, 16)} ${r.replied_by === 'human' ? 'you' : r.replied_by}: ${clip(r.message, 200)}`);
  const parts = [answers.length > 0 ? plural(answers.length, 'answer') : '', replies.length > 0 ? plural(replies.length, 'reply', 'replies') : ''].filter(Boolean);
  return { title: `you → ${task.contract.recipient} (${parts.join(', ') || 'nothing yet'})`, lines: [...answers, ...replies] };
}

// --- nodes ---------------------------------------------------------------------------------------

function describeAgent(state: State, task: TaskView): ObjectDescription {
  const c = task.contract;
  const lines: string[] = [];
  lines.push(`role: ${c.recipient} (${c.runtime}${task.agent ? `, pane ${task.agent.pane_id}` : ''})`);
  lines.push(`runtime: ${task.runtime} · task: ${task.task_state} · handoff: ${task.handoff_state}`);
  if (task.worktree) lines.push(`worktree: ${task.worktree.path} (${task.worktree.branch})`);
  const repair = task.active_repair ? ` (${repairName(task.active_repair.id)} open for ${task.active_repair.failed_criteria.join(', ')})` : '';
  lines.push(`attempt: ${task.attempt}${task.repairs.length > 0 ? ` · repairs: ${task.repairs.length}${repair}` : ''}`);
  if (task.blocker) lines.push(`blocker: ${clip(task.blocker.reason, 200)}${task.blocker.waiting_on ? ` (waiting on ${task.blocker.waiting_on})` : ''}`);
  if (c.dependencies.length > 0) {
    lines.push(`depends on: ${c.dependencies.map((d) => `${d} (${state.tasks[d]?.task_state ?? 'unknown'})`).join(', ')}`);
  }
  if (task.escalated) lines.push('escalated: needs a planner or human decision');
  return { title: `${c.recipient} · ${task.id}`, lines };
}

function describeVerifier(state: State): ObjectDescription {
  const m = state.metrics;
  const verified = sortedTasks(state).filter((t) => t.handoff_state === 'verified').length;
  return {
    title: VERIFIER,
    lines: [
      `${plural(m.criteria_total, 'criterion', 'criteria')}, ${m.criteria_with_machine_check} machine-checked, ${plural(m.self_report_mismatches, 'mismatch', 'mismatches')}`,
      `${plural(m.repairs_total, 'repair')}, ${plural(verified, 'task')} verified`,
    ],
  };
}

function describePlanner(state: State): ObjectDescription {
  const lines: string[] = [];
  for (const m of sortedMissions(state)) {
    lines.push(`mission ${m.mission.id}: ${m.mission.title} (${m.status})`);
    lines.push(`${plural(m.task_ids.length, 'task')} planned`);
    const open = m.open_questions?.length ?? 0;
    if (open > 0) lines.push(`${plural(open, 'open question')} for you`);
    const answered = m.clarifications?.length ?? 0;
    if (answered > 0) lines.push(`${plural(answered, 'question')} answered`);
  }
  if (lines.length === 0) lines.push('no mission yet');
  return { title: PLANNER, lines };
}

function describeHuman(graph: Graph): ObjectDescription {
  return { title: 'you', lines: [`${plural(graph.inbox.length, 'open inbox item')}`] };
}

// --- dispatch ------------------------------------------------------------------------------------

export function describe(ref: GraphObjectRef, graph: Graph, state: State): ObjectDescription {
  if (ref.kind === 'inbox') {
    const item = graph.inbox.find((i) => i.id === ref.id);
    return item ? { title: item.title, lines: [...item.detail] } : none(ref);
  }
  if (ref.kind === 'node') {
    if (ref.id === HUMAN) return describeHuman(graph);
    if (ref.id === PLANNER) return describePlanner(state);
    if (ref.id === VERIFIER) return describeVerifier(state);
    const task = state.tasks[ref.id];
    return task ? describeAgent(state, task) : none(ref);
  }
  const idx = ref.id.indexOf(':');
  if (idx === -1) return none(ref);
  const prefix = ref.id.slice(0, idx);
  const rest = ref.id.slice(idx + 1);
  if (prefix === 'question' && (rest === 'mission' || rest.startsWith('mission:'))) {
    return describeMissionQuestion(state, rest === 'mission' ? sortedMissions(state)[0]?.mission.id : rest.slice('mission:'.length));
  }
  if (prefix === 'dep') {
    const [producer, consumer] = rest.split('->');
    return producer && consumer ? describeDependency(state, producer, consumer) : none(ref);
  }
  const task = state.tasks[rest];
  if (!task) return none(ref);
  switch (prefix) {
    case 'contract':
      return describeContract(task);
    case 'evidence':
      return describeEvidence(task);
    case 'question':
      return describeQuestion(task);
    case 'reply':
      return describeReply(task);
    default:
      return none(ref);
  }
}
