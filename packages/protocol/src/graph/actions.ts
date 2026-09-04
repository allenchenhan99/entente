/**
 * What a human can do to a graph object right now. Pure function of `State`; the graph is only used to
 * resolve inbox refs. Order is fixed: clarify, review, reply, focus, inspect, cancel.
 */
import type { State, TaskView } from '../state.js';
import type { Graph, GraphObjectRef, ObjectAction } from './types.js';
import { HUMAN, PLANNER, VERIFIER, pendingHumanReviews, sortedMissions } from './common.js';

const ORDER: Record<ObjectAction['kind'], number> = { clarify: 0, mission_clarify: 0, review: 1, reply: 2, focus: 3, inspect: 4, cancel: 5 };

const byOrder = (a: ObjectAction, b: ObjectAction) => ORDER[a.kind] - ORDER[b.kind];

export function clarifyAction(task: TaskView): ObjectAction | undefined {
  if (task.open_questions.length === 0) return undefined;
  return {
    key: 'a',
    kind: 'clarify',
    label: `answer ${task.contract.recipient}'s ${task.open_questions.length === 1 ? 'question' : `${task.open_questions.length} questions`}`,
    target: { task_id: task.id, question_ids: task.open_questions.map((q) => q.id) },
  };
}

export function missionClarifyAction(state: State, missionId: string): ObjectAction | undefined {
  const mission = state.missions[missionId];
  const questions = mission?.open_questions ?? [];
  if (!mission || questions.length === 0) return undefined;
  return {
    key: 'a',
    kind: 'mission_clarify',
    label: `answer the planner's ${questions.length === 1 ? 'question' : `${questions.length} questions`}`,
    target: { mission_id: missionId, question_ids: questions.map((q) => q.id) },
  };
}

export function reviewActions(task: TaskView, criterionId: string): ObjectAction[] {
  return [
    { key: 'p', kind: 'review', label: `mark ${criterionId} passed`, target: { task_id: task.id, criterion_id: criterionId } },
    { key: 'f', kind: 'review', label: `mark ${criterionId} failed`, target: { task_id: task.id, criterion_id: criterionId } },
  ];
}

export function replyAction(task: TaskView): ObjectAction | undefined {
  if (!task.blocker) return undefined;
  return { key: 'r', kind: 'reply', label: `reply to ${task.contract.recipient}`, target: { task_id: task.id } };
}

export function cancelAction(task: TaskView): ObjectAction | undefined {
  if (task.task_state === 'completed' || task.task_state === 'canceled') return undefined;
  return { key: 'x', kind: 'cancel', label: `cancel ${task.id}`, target: { task_id: task.id } };
}

export function focusAction(task: TaskView): ObjectAction | undefined {
  if (!task.agent) return undefined;
  return { key: 'Enter', kind: 'focus', label: `focus ${task.contract.recipient}'s pane`, target: { task_id: task.id } };
}

export function inspectAction(taskId?: string): ObjectAction {
  return { key: 'i', kind: 'inspect', label: 'inspect', target: taskId ? { task_id: taskId } : {} };
}

const compact = (actions: Array<ObjectAction | undefined>): ObjectAction[] =>
  actions.filter((a): a is ObjectAction => a !== undefined).sort(byOrder);

/** Everything a human can do to an agent node: the union of its edges' actions. */
export function agentNodeActions(task: TaskView): ObjectAction[] {
  return compact([
    clarifyAction(task),
    ...pendingHumanReviews(task).flatMap((id) => reviewActions(task, id)),
    replyAction(task),
    focusAction(task),
    inspectAction(task.id),
    cancelAction(task),
  ]);
}

export function contractEdgeActions(task: TaskView): ObjectAction[] {
  return compact([clarifyAction(task), inspectAction(task.id), cancelAction(task)]);
}

export function evidenceEdgeActions(task: TaskView): ObjectAction[] {
  return compact([...pendingHumanReviews(task).flatMap((id) => reviewActions(task, id)), inspectAction(task.id), cancelAction(task)]);
}

export function actionsFor(ref: GraphObjectRef, graph: Graph, state: State): ObjectAction[] {
  if (ref.kind === 'inbox') return graph.inbox.find((i) => i.id === ref.id)?.actions ?? [];

  if (ref.kind === 'node') {
    if (ref.id === PLANNER) {
      return compact([...sortedMissions(state).map((m) => missionClarifyAction(state, m.mission.id)), inspectAction()]);
    }
    if (ref.id === HUMAN || ref.id === VERIFIER) return [inspectAction()];
    const task = state.tasks[ref.id];
    return task ? agentNodeActions(task) : [];
  }

  // edges
  const edge = graph.edges.find((e) => e.id === ref.id);
  const [prefix, rest] = splitId(ref.id);
  if (prefix === 'question' && rest.startsWith('mission')) {
    const missionId = rest === 'mission' ? sortedMissions(state)[0]?.mission.id : rest.slice('mission:'.length);
    return compact([missionId ? missionClarifyAction(state, missionId) : undefined, inspectAction()]);
  }
  const taskId = edge?.task_id ?? (prefix === 'dep' ? rest.split('->')[1] : rest);
  const task = taskId ? state.tasks[taskId] : undefined;
  if (!task) return edge ? [inspectAction()] : [];
  switch (prefix) {
    case 'contract':
      return contractEdgeActions(task);
    case 'evidence':
      return evidenceEdgeActions(task);
    case 'question':
      return compact([clarifyAction(task), inspectAction(task.id)]);
    case 'dep':
    case 'reply':
      return [inspectAction(task.id)];
    default:
      return [inspectAction(task.id)];
  }
}

function splitId(id: string): [string, string] {
  const idx = id.indexOf(':');
  return idx === -1 ? [id, ''] : [id.slice(0, idx), id.slice(idx + 1)];
}
