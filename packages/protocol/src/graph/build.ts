/**
 * `buildGraph(state)`: the whole object graph (nodes, edges, inbox) as a pure function of `State`.
 * Deterministic ordering: nodes by column then id; edges by kind then id; inbox oldest first.
 */
import type { MissionView, State, TaskView } from '../state.js';
import type { Graph, GraphEdge, GraphNode, InboxItem, VisualStatus } from './types.js';
import {
  HUMAN, PLANNER, VERIFIER, hasStartedWork, isFailed, isLintBlocked, latestRecord, lintErrorsOf,
  missionQuestionEdgeId, pendingHumanReviews, plural, sortedMissions, sortedTasks,
} from './common.js';
import { agentNodeActions, clarifyAction, contractEdgeActions, inspectAction, missionClarifyAction, replyAction, reviewActions } from './actions.js';

// --- nodes -------------------------------------------------------------------------------------

export function agentStatus(task: TaskView): VisualStatus {
  if (isFailed(task)) return 'failed';
  if (task.task_state === 'completed') return 'verified';
  if (task.blocker) return 'blocked';
  if (task.handoff_state === 'needs_clarification' || task.open_questions.length > 0 || pendingHumanReviews(task).length > 0) return 'attention';
  if (task.handoff_state === 'evidence_submitted' || task.task_state === 'awaiting_verification') return 'done';
  if (task.task_state === 'executing' || task.task_state === 'repairing' || task.runtime === 'working' || task.handoff_state === 'retry_requested') return 'working';
  return 'pending';
}

function agentBadge(task: TaskView): string | undefined {
  if (task.blocker) return '◐ blocked';
  if (task.open_questions.length > 0) return `? ${task.open_questions.length}`;
  if (task.attempt > 0) return `a${task.attempt}`;
  return undefined;
}

function agentNode(task: TaskView): GraphNode {
  const node: GraphNode = {
    id: task.id,
    kind: 'agent',
    label: task.contract.recipient,
    task_id: task.id,
    runtime: task.runtime,
    task_state: task.task_state,
    handoff_state: task.handoff_state,
    column: 1,
    status: agentStatus(task),
  };
  const badge = agentBadge(task);
  if (badge !== undefined) node.badge = badge;
  return node;
}

function plannerStatus(missions: MissionView[]): VisualStatus {
  if (missions.length === 0) return 'pending';
  if (missions.some((m) => (m.open_questions?.length ?? 0) > 0)) return 'attention';
  if (missions.some((m) => m.status === 'failed' || m.status === 'canceled')) return 'failed';
  if (missions.every((m) => m.status === 'verified')) return 'verified';
  if (missions.some((m) => m.status === 'planning')) return 'working';
  return 'done';
}

function verifierStatus(tasks: TaskView[], missions: MissionView[]): VisualStatus {
  if (tasks.some((t) => pendingHumanReviews(t).length > 0)) return 'attention';
  if (tasks.some((t) => t.handoff_state === 'evidence_submitted' || t.task_state === 'awaiting_verification')) return 'working';
  if (tasks.some((t) => t.handoff_state === 'retry_requested')) return 'attention';
  if (tasks.length > 0 && tasks.every((t) => t.task_state === 'completed')) {
    return missions.length > 0 && missions.every((m) => m.status === 'verified') ? 'verified' : 'done';
  }
  return 'pending';
}

// --- edges -------------------------------------------------------------------------------------

function contractEdge(task: TaskView): GraphEdge {
  const v = task.contract.version;
  let label = `v${v}`;
  let status: VisualStatus = 'pending';
  let attention = false;
  switch (task.handoff_state) {
    case 'needs_clarification':
      label = `? ${task.open_questions.length}`;
      status = 'attention';
      attention = true;
      break;
    case 'accepted':
    case 'evidence_submitted':
    case 'retry_requested':
      label = `v${v} ✓`;
      status = 'done';
      break;
    case 'verified':
      label = `v${v} ✓`;
      status = 'verified';
      break;
    case 'rejected':
      label = `v${v} ✗`;
      status = 'failed';
      break;
    case 'draft':
    case 'proposed':
    case 'revised':
    default:
      if (isLintBlocked(task)) {
        label = 'lint ✗';
        status = 'attention';
        attention = true;
      }
      break;
  }
  if (task.task_state === 'canceled' || task.task_state === 'failed') status = 'failed';
  return { id: `contract:${task.id}`, kind: 'contract', from: PLANNER, to: task.id, task_id: task.id, label, status, attention, version: v };
}

function evidenceEdge(task: TaskView): GraphEdge | undefined {
  if (!hasStartedWork(task)) return undefined;
  let label = 'awaiting evidence';
  let status: VisualStatus = 'pending';
  let attention = false;
  if (task.handoff_state === 'verified') {
    label = '✓';
    status = 'verified';
  } else if (task.handoff_state === 'retry_requested') {
    const failed = task.active_repair?.failed_criteria ?? latestRecord(task)?.self_report_mismatch ?? [];
    label = `${failed.length > 0 ? failed.join(', ') : 'checks'} ✗`;
    status = 'attention';
    attention = true;
  } else if (task.handoff_state === 'evidence_submitted') {
    label = `#${task.attempt}`;
    if (pendingHumanReviews(task).length > 0) {
      status = 'attention';
      attention = true;
    } else {
      status = 'working';
    }
  }
  if (task.task_state === 'canceled' || task.task_state === 'failed') {
    status = 'failed';
    if (task.handoff_state !== 'verified') label = task.task_state === 'canceled' ? 'canceled' : '✗';
  } else if (task.escalated && task.handoff_state !== 'verified') {
    label = 'escalated';
    status = 'failed';
  }
  return { id: `evidence:${task.id}`, kind: 'evidence', from: task.id, to: VERIFIER, task_id: task.id, label, status, attention };
}

function dependencyEdges(task: TaskView, nodes: Map<string, GraphNode>): GraphEdge[] {
  return task.contract.dependencies
    .filter((dep) => nodes.has(dep))
    .map((dep) => ({
      id: `dep:${dep}->${task.id}`,
      kind: 'dependency' as const,
      from: dep,
      to: task.id,
      task_id: task.id,
      label: 'dep',
      status: nodes.get(dep)!.status,
      attention: false,
    }));
}

function questionEdge(task: TaskView): GraphEdge | undefined {
  if (task.open_questions.length === 0) return undefined;
  return {
    id: `question:${task.id}`,
    kind: 'question',
    from: task.id,
    to: HUMAN,
    task_id: task.id,
    label: `? ${task.open_questions.length}`,
    status: 'attention',
    attention: true,
    version: task.contract.version,
  };
}

function missionQuestionEdge(state: State, mission: MissionView): GraphEdge | undefined {
  const n = mission.open_questions?.length ?? 0;
  if (n === 0) return undefined;
  return { id: missionQuestionEdgeId(state, mission.mission.id), kind: 'question', from: PLANNER, to: HUMAN, label: `? ${n}`, status: 'attention', attention: true };
}

function replyEdge(task: TaskView): GraphEdge | undefined {
  const n = (task.replies?.length ?? 0) + task.contract.clarifications.length;
  if (n === 0) return undefined;
  return { id: `reply:${task.id}`, kind: 'reply', from: HUMAN, to: task.id, task_id: task.id, label: `↩ ${n}`, status: 'done', attention: false };
}

// --- inbox -------------------------------------------------------------------------------------

function inboxFor(state: State, mission: MissionView, tasks: TaskView[]): InboxItem[] {
  const items: InboxItem[] = [];
  const missionId = mission.mission.id;

  const mq = mission.open_questions ?? [];
  if (mq.length > 0) {
    items.push({
      id: `mission_question:${missionId}`,
      kind: 'mission_question',
      mission_id: missionId,
      title: `planner asks you ${plural(mq.length, 'question')} before decomposing`,
      detail: mq.map((q) => `${q.id}: ${q.text}`),
      ref: { kind: 'edge', id: missionQuestionEdgeId(state, missionId) },
      actions: [missionClarifyAction(state, missionId)!, inspectAction()],
    });
  }

  for (const task of tasks) {
    const role = task.contract.recipient;
    const base = { mission_id: missionId, task_id: task.id };

    if (task.open_questions.length > 0) {
      items.push({
        id: `task_question:${task.id}`,
        kind: 'task_question',
        ...base,
        title: `${role} asks ${plural(task.open_questions.length, 'question')} (v${task.contract.version})`,
        detail: task.open_questions.map((q) => `${q.id}: ${q.text}`),
        since: task.proposed_at,
        ref: { kind: 'edge', id: `contract:${task.id}` },
        actions: [clarifyAction(task)!, inspectAction(task.id)],
      });
    }

    for (const criterionId of pendingHumanReviews(task)) {
      const criterion = task.contract.acceptance_criteria.find((ac) => ac.id === criterionId);
      items.push({
        id: `human_review:${task.id}:${criterionId}`,
        kind: 'human_review',
        ...base,
        title: `${role} needs your review of ${criterionId} (attempt ${task.attempt})`,
        detail: [criterion?.condition ?? criterionId],
        since: task.last_seen_at,
        ref: { kind: 'edge', id: `evidence:${task.id}` },
        actions: [...reviewActions(task, criterionId), inspectAction(task.id)],
      });
    }

    if (task.blocker) {
      const waiting = task.blocker.waiting_on;
      items.push({
        id: `blocker:${task.id}`,
        kind: 'blocker',
        ...base,
        title: `${role} is stuck${waiting ? ` (waiting on ${waiting})` : ''}`,
        detail: [task.blocker.reason, ...(waiting ? [`waiting on ${waiting}`] : [])],
        since: task.blocker.since,
        ref: { kind: 'node', id: task.id },
        actions: [replyAction(task)!, inspectAction(task.id)],
      });
    }

    if (task.escalated || task.task_state === 'failed') {
      const repair = task.repairs[task.repairs.length - 1];
      const detail = [
        task.task_state === 'failed' ? `failed after ${plural(task.attempt, 'attempt')}` : 'escalated: needs a planner or human decision',
        ...(repair ? [`${repair.failed_criteria.join(', ')}: ${repair.observed_failure}`] : []),
      ];
      items.push({
        id: `escalation:${task.id}`,
        kind: 'escalation',
        ...base,
        title: task.task_state === 'failed' ? `${role} failed ${task.id} (budget exhausted)` : `${role}'s ${task.id} is escalated`,
        detail,
        since: task.completed_at ?? task.last_seen_at,
        ref: { kind: 'node', id: task.id },
        actions: agentNodeActions(task),
      });
    }

    const errors = lintErrorsOf(task);
    if (errors.length > 0 && task.runtime === 'unspawned') {
      items.push({
        id: `lint_error:${task.id}`,
        kind: 'lint_error',
        ...base,
        title: `${task.id} v${task.contract.version} cannot be spawned: ${plural(errors.length, 'lint error')}`,
        detail: errors.map((r) => `${r.rule}: ${r.message}`),
        since: task.proposed_at,
        ref: { kind: 'edge', id: `contract:${task.id}` },
        actions: contractEdgeActions(task),
      });
    }
  }
  return items;
}

// --- graph -------------------------------------------------------------------------------------

const COLUMN_THEN_ID = (a: GraphNode, b: GraphNode) => a.column - b.column || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const KIND_THEN_ID = (a: GraphEdge, b: GraphEdge) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildGraph(state: State): Graph {
  const tasks = sortedTasks(state);
  const missions = sortedMissions(state);

  const agents = tasks.map(agentNode);
  const byId = new Map(agents.map((n) => [n.id, n]));

  const edges: GraphEdge[] = [];
  for (const task of tasks) {
    edges.push(contractEdge(task));
    const ev = evidenceEdge(task);
    if (ev) edges.push(ev);
    edges.push(...dependencyEdges(task, byId));
    const q = questionEdge(task);
    if (q) edges.push(q);
    const r = replyEdge(task);
    if (r) edges.push(r);
  }
  for (const mission of missions) {
    const q = missionQuestionEdge(state, mission);
    if (q) edges.push(q);
  }

  const inbox = missions
    .flatMap((m) => inboxFor(state, m, tasks.filter((t) => t.mission_id === m.mission.id)))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const sa = a.item.since ?? '';
      const sb = b.item.since ?? '';
      return sa < sb ? -1 : sa > sb ? 1 : a.index - b.index;
    })
    .map(({ item }) => item);

  const nodes: GraphNode[] = [
    { id: HUMAN, kind: 'human', label: 'human', column: 0, status: inbox.length > 0 ? 'attention' : 'pending' },
    { id: PLANNER, kind: 'planner', label: 'planner', column: 0, status: plannerStatus(missions) },
    ...agents,
    { id: VERIFIER, kind: 'verifier', label: 'verifier', column: 2, status: verifierStatus(tasks, missions) },
  ];

  return { nodes: nodes.sort(COLUMN_THEN_ID), edges: edges.sort(KIND_THEN_ID), inbox };
}
