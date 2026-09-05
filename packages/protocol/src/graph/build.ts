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

/**
 * The node a task's contract comes from: its parent agent for a subtask (agent networking), otherwise the
 * sender — `planner`, `human`, or the agent whose task has that role (`agent:<role>` or a bare role) in the
 * same mission. Unknown senders fall back to the planner so every contract edge has an origin.
 */
function senderNode(task: TaskView, tasks: TaskView[]): string {
  const parent = task.contract.parent_task;
  if (parent !== undefined && parent !== task.id && tasks.some((t) => t.id === parent)) return parent;
  const sender = task.contract.sender;
  if (sender === PLANNER) return PLANNER;
  if (sender === HUMAN) return HUMAN;
  const role = sender.startsWith('agent:') ? sender.slice('agent:'.length) : sender;
  const byRole = tasks.find((t) => t.id !== task.id && t.mission_id === task.mission_id && t.contract.recipient === role);
  return byRole ? byRole.id : PLANNER;
}

/**
 * What the delegating parent sees on its edge to a subtask — the `relay_await_task` outcome made visible:
 * waiting (child still working), merged (child verified and landed in the parent's worktree), conflict
 * (relayd could not merge; the parent is blocked), failed / canceled (the parent must decide what to do).
 */
function delegationLabel(child: TaskView, parent: TaskView | undefined): { label: string; status: VisualStatus; attention: boolean } | undefined {
  const v = child.contract.version;
  const conflict = parent?.blocker?.reason.includes(`subtask ${child.id} could not be merged`) ?? false;
  switch (child.task_state) {
    case 'completed':
      return conflict ? { label: `sub ✗ conflict`, status: 'attention', attention: true } : { label: `sub ✓ merged`, status: 'verified', attention: false };
    case 'failed':
      return { label: 'sub ✗ failed', status: 'failed', attention: true };
    case 'canceled':
      return { label: 'sub ✗ canceled', status: 'failed', attention: true };
    case 'accepted':
    case 'executing':
    case 'awaiting_verification':
    case 'repairing':
      return { label: `sub ⏳ v${v}`, status: 'working', attention: false };
    default:
      return undefined; // proposed / needs_clarification / lint-blocked: the generic contract labels apply, prefixed below
  }
}

function contractEdge(task: TaskView, from: string, parent?: TaskView): GraphEdge {
  const v = task.contract.version;
  const isSubtask = task.contract.parent_task !== undefined && from === task.contract.parent_task;
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
  if (isSubtask) {
    // A delegation edge (parent agent → subtask) shows the await_task outcome from the parent's point of view.
    const d = delegationLabel(task, parent);
    if (d) ({ label, status, attention } = d);
    else label = `sub ${label}`;
  }
  return { id: `contract:${task.id}`, kind: 'contract', from, to: task.id, task_id: task.id, label, status, attention, version: v };
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
      // A planner that cannot decompose has stopped the whole mission, so of everything in the inbox
      // this is the item whose age matters most. It had none until now, and sorted by an empty string.
      since: mission.questions_asked_at,
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

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Position of every agent in column 1. Top-level tasks keep their id order; each subtask sits right after
 * its parent (and the parent's earlier subtasks), siblings ordered by dependency depth among themselves, then
 * id. Tasks whose parent chain is cyclic or unknown are appended in id order so the map is total.
 */
function agentRanks(tasks: TaskView[]): Map<string, number> {
  const known = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map<string, TaskView[]>();
  const roots: TaskView[] = [];
  for (const t of tasks) {
    const parent = t.contract.parent_task;
    if (parent !== undefined && parent !== t.id && known.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(t);
      children.set(parent, list);
    } else {
      roots.push(t);
    }
  }
  const ranks = new Map<string, number>();
  const visit = (task: TaskView): void => {
    if (ranks.has(task.id)) return;
    ranks.set(task.id, ranks.size);
    const kids = children.get(task.id) ?? [];
    const ids = new Set(kids.map((k) => k.id));
    const depth = (id: string, seen: Set<string>): number => {
      const kid = known.get(id);
      if (!kid || seen.has(id)) return 0;
      seen.add(id);
      return Math.max(0, ...kid.contract.dependencies.filter((d) => ids.has(d)).map((d) => 1 + depth(d, seen)));
    };
    for (const kid of [...kids].sort((a, b) => depth(a.id, new Set()) - depth(b.id, new Set()) || byId(a.id, b.id))) visit(kid);
  };
  for (const root of roots) visit(root);
  for (const t of tasks) visit(t);
  return ranks;
}

const columnThenRankThenId = (ranks: Map<string, number>) => (a: GraphNode, b: GraphNode) =>
  a.column - b.column || (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0) || byId(a.id, b.id);
const KIND_THEN_ID = (a: GraphEdge, b: GraphEdge) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildGraph(state: State): Graph {
  const tasks = sortedTasks(state);
  const missions = sortedMissions(state);

  const agents = tasks.map(agentNode);
  const nodesById = new Map(agents.map((n) => [n.id, n]));

  const edges: GraphEdge[] = [];
  for (const task of tasks) {
    edges.push(contractEdge(task, senderNode(task, tasks), task.contract.parent_task ? tasks.find((t) => t.id === task.contract.parent_task) : undefined));
    const ev = evidenceEdge(task);
    if (ev) edges.push(ev);
    edges.push(...dependencyEdges(task, nodesById));
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

  return { nodes: nodes.sort(columnThenRankThenId(agentRanks(tasks))), edges: edges.sort(KIND_THEN_ID), inbox };
}
