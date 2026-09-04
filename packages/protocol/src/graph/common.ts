/**
 * Internal helpers shared by the graph object model (build, actions, narrate, story, describe).
 * Pure functions of `State` / `TaskView`; nothing here does IO.
 */
import type { Actor } from '../events.js';
import type { EvidenceRecord } from '../contract.js';
import type { MissionView, State, TaskView } from '../state.js';
import { hasLintErrors } from '../lint.js';

export const HUMAN = 'human';
export const PLANNER = 'planner';
export const VERIFIER = 'verifier';

/** Display name of an actor: `you` for the human, `RelayGraph` for relayd, the role for agents. */
export function actorName(actor: Actor | string): string {
  if (actor === 'human') return 'you';
  if (actor === 'relayd') return 'RelayGraph';
  if (actor === 'planner') return 'planner';
  if (actor.startsWith('agent:')) return actor.slice('agent:'.length);
  return actor;
}

/** Role (contract recipient) of a task, or the task id when the task is unknown. */
export function roleOf(state: State, taskId: string | undefined): string {
  if (taskId === undefined) return 'an agent';
  return state.tasks[taskId]?.contract.recipient ?? taskId;
}

export function sortedTasks(state: State): TaskView[] {
  return Object.values(state.tasks).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sortedMissions(state: State): MissionView[] {
  return Object.values(state.missions).sort((a, b) => (a.mission.id < b.mission.id ? -1 : a.mission.id > b.mission.id ? 1 : 0));
}

/** The evidence record of the current attempt, if relayd has recorded it. */
export function latestRecord(task: TaskView): EvidenceRecord | undefined {
  return task.attempts.length > 0 ? task.attempts[task.attempts.length - 1] : undefined;
}

/**
 * Criteria ids whose human review is still pending: the current attempt's record lists them as
 * `pending_human` and no verdict (repair or verification) has been reached for that attempt yet.
 */
export function pendingHumanReviews(task: TaskView): string[] {
  if (task.handoff_state !== 'evidence_submitted') return [];
  const record = latestRecord(task);
  if (!record || record.attempt !== task.attempt) return [];
  return Object.entries(record.checks)
    .filter(([, r]) => r.status === 'pending_human')
    .map(([id]) => id);
}

export function lintErrorsOf(task: TaskView) {
  return task.lint.filter((r) => r.severity === 'error');
}

export const isLintBlocked = (task: TaskView): boolean => hasLintErrors(task.lint);

export const isTerminal = (task: TaskView): boolean =>
  task.task_state === 'completed' || task.task_state === 'canceled' || task.task_state === 'failed';

export const isFailed = (task: TaskView): boolean =>
  task.task_state === 'failed' || task.task_state === 'canceled' || task.escalated || task.handoff_state === 'rejected';

/** Has the agent started producing anything the verifier could look at? */
export const hasStartedWork = (task: TaskView): boolean =>
  task.started_at !== undefined ||
  task.attempt > 0 ||
  task.task_state === 'executing' ||
  task.task_state === 'awaiting_verification' ||
  task.task_state === 'repairing';

/** Deterministic id of the mission-level question edge / inbox item. */
export function missionQuestionEdgeId(state: State, missionId: string): string {
  return Object.keys(state.missions).length <= 1 ? 'question:mission' : `question:mission:${missionId}`;
}

/** Truncate a quote to `max` characters, ending with `…` when cut. */
export function clip(text: string, max = 120): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1).trimEnd()}…`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Short repair name (`r1`) from a repair id like `t-backend-auth/r1`. */
export function repairName(id: string): string {
  const idx = id.lastIndexOf('/');
  return idx === -1 ? id : id.slice(idx + 1);
}

/** `2 passed, 1 failed, 1 pending review` from check / claim statuses, skipping zero counts. */
export function tally(statuses: string[], empty = 'nothing'): string {
  const order: Array<[string, string]> = [['passed', 'passed'], ['failed', 'failed'], ['skipped', 'skipped'], ['pending_human', 'pending review'], ['error', 'errored']];
  const counts = new Map<string, number>();
  for (const st of statuses) counts.set(st, (counts.get(st) ?? 0) + 1);
  const parts = order.filter(([k]) => counts.has(k)).map(([k, label]) => `${counts.get(k)} ${label}`);
  return parts.length > 0 ? parts.join(', ') : empty;
}

/** Summary of an evidence record: tallied checks plus any self-report mismatch. */
export function recordSummary(record: EvidenceRecord): string {
  const mismatch = record.self_report_mismatch.length > 0 ? ` (self-report mismatch on ${record.self_report_mismatch.join(', ')})` : '';
  return `${tally(Object.values(record.checks).map((c) => c.status), 'no checks')}${mismatch}`;
}
