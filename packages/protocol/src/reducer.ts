/**
 * The state reducer: `State = reduce(events)`. Pure, total (never throws on a valid `Event`),
 * and idempotent on `seq` (events with `seq <= state.last_seq` are ignored). See PRD.md §6.6, §7, §15.
 *
 * Three independent layers per task (PRD §7.1): `handoff_state`, `task_state`, `runtime`.
 * No I/O, no clocks — timestamps come from the events themselves.
 */
import type { Event, EventType } from './events.js';
import type { Metrics, MissionView, State, TaskView } from './state.js';
import { initialState } from './state.js';
import type { TaskContract } from './contract.js';
import { hasLintErrors } from './lint.js';

/** Task states counted as "not re-run" when a sibling task is repaired (PRD §15). */
const NOT_RERUN_STATES: ReadonlySet<TaskView['task_state']> = new Set(['executing', 'awaiting_verification', 'completed']);

const isMachineCheck = (kind: string | undefined): boolean => kind !== undefined && kind !== 'human_review' && kind !== 'llm_judge';

function newTaskView(contract: TaskContract, ts: string): TaskView {
  return {
    id: contract.id,
    mission_id: contract.mission_id,
    contract,
    versions: [contract],
    response: undefined,
    open_questions: [],
    lint: [],
    runtime: 'unspawned',
    task_state: 'proposed',
    handoff_state: 'proposed',
    worktree: undefined,
    agent: undefined,
    blocker: undefined,
    blocked_on_dependencies: [],
    attempt: 0,
    attempts: [],
    repairs: [],
    active_repair: undefined,
    escalated: false,
    proposed_at: ts,
    accepted_at: undefined,
    started_at: undefined,
    last_seen_at: undefined,
    completed_at: undefined,
  };
}

/** Recompute `blocked_on_dependencies` for every task from the current contracts and task states. */
function recomputeDependencies(tasks: State['tasks']): State['tasks'] {
  const out: State['tasks'] = {};
  for (const [id, task] of Object.entries(tasks)) {
    const blocked = task.contract.dependencies.filter((dep) => tasks[dep]?.task_state !== 'completed');
    const same = blocked.length === task.blocked_on_dependencies.length && blocked.every((d, i) => d === task.blocked_on_dependencies[i]);
    out[id] = same ? task : { ...task, blocked_on_dependencies: blocked };
  }
  return out;
}

/** Recompute the criteria metrics from every task's *current* contract. */
function recomputeCriteria(tasks: State['tasks'], metrics: Metrics): Metrics {
  let total = 0;
  let machine = 0;
  for (const task of Object.values(tasks)) {
    for (const ac of task.contract.acceptance_criteria) {
      total += 1;
      if (isMachineCheck(ac.check?.kind)) machine += 1;
    }
  }
  return { ...metrics, criteria_total: total, criteria_with_machine_check: machine };
}

type TaskPatch = Partial<TaskView>;

/**
 * Per-task transitions. Returns `undefined` when the event does not touch the task.
 * `task` is the current view (always defined here) and `ts` the event timestamp.
 */
function taskTransition(task: TaskView, event: Event): TaskPatch | undefined {
  const ts = event.ts;
  switch (event.type) {
    case 'task_proposed': {
      const { contract } = event.payload;
      return { contract, versions: [...task.versions, contract], handoff_state: 'proposed', task_state: 'proposed', proposed_at: ts };
    }
    case 'clarification_requested':
      return { handoff_state: 'needs_clarification', response: event.payload.response, open_questions: event.payload.response.questions };
    case 'clarification_answered': {
      const answered = new Set(event.payload.answers.map((a) => a.question_id));
      return { handoff_state: 'revised', open_questions: task.open_questions.filter((q) => !answered.has(q.id)) };
    }
    case 'contract_revised': {
      const { contract } = event.payload;
      return { contract, versions: [...task.versions, contract], handoff_state: 'proposed', proposed_at: ts };
    }
    case 'task_accepted':
      return { handoff_state: 'accepted', task_state: 'accepted', response: event.payload.response, accepted_at: ts };
    case 'task_rejected':
      return { handoff_state: 'rejected', response: event.payload.response };
    case 'lint_reported':
      return { lint: event.payload.results };

    case 'worktree_created':
      return { worktree: { path: event.payload.path, branch: event.payload.branch } };
    case 'agent_spawned':
      return { runtime: 'idle', agent: { runtime: event.payload.runtime, pane_id: event.payload.pane_id, session_id: event.payload.session_id }, last_seen_at: ts };
    case 'agent_exited':
      return { runtime: 'exited' };

    case 'work_started':
      return { runtime: 'working', task_state: 'executing', started_at: task.started_at ?? ts, last_seen_at: ts };
    case 'progress_reported':
      return { runtime: 'working', last_seen_at: ts };
    case 'task_blocked':
      return { runtime: 'blocked', blocker: { reason: event.payload.reason, waiting_on: event.payload.waiting_on, since: ts }, last_seen_at: ts };
    case 'task_unblocked':
      return { runtime: 'working', blocker: undefined, last_seen_at: ts };

    case 'evidence_submitted':
      return {
        runtime: 'done',
        task_state: 'awaiting_verification',
        handoff_state: 'evidence_submitted',
        attempt: Math.max(task.attempt, event.payload.submission.attempt),
        last_seen_at: ts,
      };
    case 'evidence_recorded':
      return { attempts: [...task.attempts, event.payload.record] };
    case 'repair_requested':
      return { handoff_state: 'retry_requested', repairs: [...task.repairs, event.payload.repair], active_repair: event.payload.repair };
    case 'repair_accepted':
      return { handoff_state: 'accepted', task_state: 'repairing', runtime: 'working', last_seen_at: ts };
    case 'task_verified':
      return { handoff_state: 'verified', active_repair: undefined };
    case 'task_completed':
      return { task_state: 'completed', completed_at: ts };
    case 'task_failed_budget':
      return { task_state: 'failed' };
    case 'task_escalated':
      return { escalated: true };
    case 'task_canceled':
      return { task_state: 'canceled' };

    case 'checks_started':
    case 'check_passed':
    case 'check_failed':
    case 'human_review_recorded':
      return undefined;
    default:
      return undefined;
  }
}

function missionTransition(mission: MissionView, event: Event): Partial<MissionView> | undefined {
  switch (event.type) {
    case 'tasks_planned':
      return { task_ids: [...new Set([...mission.task_ids, ...event.payload.task_ids])] };
    case 'task_proposed':
      return mission.task_ids.includes(event.payload.contract.id) ? undefined : { task_ids: [...mission.task_ids, event.payload.contract.id] };
    case 'task_accepted':
      return mission.status === 'planning' ? { status: 'executing' } : undefined;
    case 'integration_started':
      return { status: 'integrating', integration: { branch: event.payload.branch, order: event.payload.order } };
    case 'integration_conflict':
      return {
        integration: {
          branch: mission.integration?.branch ?? '',
          order: mission.integration?.order ?? [],
          conflict: { task_id: event.payload.task_id, files: event.payload.files },
        },
      };
    case 'mission_verified':
      return { status: 'verified' };
    case 'mission_failed':
      return { status: 'failed' };
    case 'mission_clarification_requested':
      return { open_questions: event.payload.questions };
    case 'mission_clarification_answered': {
      const answered = new Set(event.payload.answers.map((a) => a.question_id));
      return {
        open_questions: (mission.open_questions ?? []).filter((q) => !answered.has(q.id)),
        clarifications: [...(mission.clarifications ?? []), ...event.payload.answers],
      };
    }
    default:
      return undefined;
  }
}

const TASK_STATE_EVENTS: ReadonlySet<EventType> = new Set([
  'task_proposed', 'contract_revised', 'task_accepted', 'work_started', 'evidence_submitted', 'repair_accepted',
  'task_completed', 'task_failed_budget', 'task_canceled',
]);

function metricsTransition(state: State, prevTask: TaskView | undefined, event: Event): Metrics | undefined {
  const m = state.metrics;
  switch (event.type) {
    case 'clarification_answered':
    case 'mission_clarification_answered':
      return { ...m, fields_filled_via_clarification: m.fields_filled_via_clarification + event.payload.answers.length };
    case 'evidence_recorded':
      return { ...m, self_report_mismatches: m.self_report_mismatches + event.payload.record.self_report_mismatch.length };
    case 'lint_reported': {
      if (!prevTask) return undefined;
      const wasBlocked = hasLintErrors(prevTask.lint);
      const nowBlocked = hasLintErrors(event.payload.results);
      return nowBlocked && !wasBlocked ? { ...m, contracts_blocked_before_execution: m.contracts_blocked_before_execution + 1 } : undefined;
    }
    case 'repair_requested': {
      if (!prevTask) return undefined;
      const notRerun = Object.values(state.tasks).filter(
        (t) => t.id !== prevTask.id && t.mission_id === prevTask.mission_id && NOT_RERUN_STATES.has(t.task_state),
      ).length;
      return { ...m, repairs_total: m.repairs_total + 1, tasks_not_rerun_on_repair: m.tasks_not_rerun_on_repair + notRerun };
    }
    default:
      return undefined;
  }
}

export function reduce(state: State, event: Event): State {
  if (event.seq <= state.last_seq) return state;

  let missions = state.missions;
  let tasks = state.tasks;
  let metrics = state.metrics;

  // --- missions -------------------------------------------------------------------------------
  if (event.type === 'mission_created') {
    const created: MissionView = { mission: event.payload, status: 'planning', task_ids: [], open_questions: [], clarifications: [] };
    missions = { ...missions, [event.payload.id]: created };
  } else {
    const mission = missions[event.mission_id];
    if (mission) {
      const patch = missionTransition(mission, event);
      if (patch) missions = { ...missions, [event.mission_id]: { ...mission, ...patch } };
    }
  }

  // --- tasks ----------------------------------------------------------------------------------
  const taskId = event.type === 'task_proposed' ? event.payload.contract.id : event.task_id;
  const prevTask = taskId !== undefined ? tasks[taskId] : undefined;
  if (taskId !== undefined) {
    if (event.type === 'task_proposed' && !prevTask) {
      tasks = { ...tasks, [taskId]: newTaskView(event.payload.contract, event.ts) };
    } else if (prevTask) {
      const patch = taskTransition(prevTask, event);
      if (patch) tasks = { ...tasks, [taskId]: { ...prevTask, ...patch } };
    }
  }

  // --- metrics --------------------------------------------------------------------------------
  metrics = metricsTransition(state, prevTask, event) ?? metrics;

  // --- derived --------------------------------------------------------------------------------
  if (TASK_STATE_EVENTS.has(event.type) && tasks !== state.tasks) {
    tasks = recomputeDependencies(tasks);
    if (event.type === 'task_proposed' || event.type === 'contract_revised') metrics = recomputeCriteria(tasks, metrics);
  }

  return { last_seq: event.seq, missions, tasks, metrics };
}

export function replay(events: Iterable<Event>, from: State = initialState()): State {
  let s = from;
  for (const e of events) s = reduce(s, e);
  return s;
}
