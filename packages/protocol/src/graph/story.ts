/**
 * `storyFor(ref, graph, state, events)`: the narrated events that concern one object, oldest first,
 * each line prefixed with `HH:MM` taken from the event's `ts` (the offset the ts string carries).
 */
import type { Event, EventType } from '../events.js';
import type { State } from '../state.js';
import type { Graph, GraphObjectRef } from './types.js';
import { HUMAN, PLANNER, VERIFIER, sortedMissions } from './common.js';
import { narrate } from './narrate.js';

type Pred = (e: Event) => boolean;

const typeIn = (...prefixes: string[]): ((t: EventType) => boolean) => (t) => prefixes.some((p) => t === p || t.startsWith(p));

const PLANNER_TYPES = typeIn('mission_', 'tasks_planned', 'task_proposed', 'integration_');
const VERIFIER_TYPES = typeIn('checks_', 'check_', 'evidence_recorded', 'task_verified', 'integration_');
const CONTRACT_TYPES = typeIn('task_proposed', 'lint_reported', 'clarification_', 'contract_revised', 'task_accepted', 'task_rejected');
const EVIDENCE_TYPES = typeIn('evidence_', 'checks_', 'check_', 'human_review_recorded', 'repair_', 'task_verified');
const QUESTION_TYPES = typeIn('clarification_');
const MISSION_QUESTION_TYPES = typeIn('mission_clarification_');
const REPLY_TYPES = typeIn('clarification_answered', 'blocker_replied', 'human_review_recorded');
const DEPENDENCY_TYPES = typeIn('task_proposed', 'task_accepted', 'work_started', 'task_verified', 'task_completed', 'task_canceled', 'task_failed_budget', 'task_escalated');

const ofTask = (taskId: string, types: (t: EventType) => boolean): Pred => (e) => e.task_id === taskId && types(e.type);

/** Which events belong to the object, or `undefined` for an unknown ref. */
function predicateFor(ref: GraphObjectRef, graph: Graph, state: State): Pred | undefined {
  if (ref.kind === 'inbox') {
    const item = graph.inbox.find((i) => i.id === ref.id);
    return item ? predicateFor(item.ref, graph, state) : undefined;
  }
  if (ref.kind === 'node') {
    if (ref.id === HUMAN) return (e) => e.actor === 'human';
    if (ref.id === PLANNER) return (e) => PLANNER_TYPES(e.type);
    if (ref.id === VERIFIER) return (e) => VERIFIER_TYPES(e.type);
    if (!state.tasks[ref.id] && !graph.nodes.some((n) => n.id === ref.id)) return undefined;
    return (e) => e.task_id === ref.id;
  }
  const idx = ref.id.indexOf(':');
  if (idx === -1) return undefined;
  const prefix = ref.id.slice(0, idx);
  const rest = ref.id.slice(idx + 1);
  switch (prefix) {
    case 'contract':
      return ofTask(rest, CONTRACT_TYPES);
    case 'evidence':
      return ofTask(rest, EVIDENCE_TYPES);
    case 'question': {
      if (rest === 'mission' || rest.startsWith('mission:')) {
        const missionId = rest === 'mission' ? sortedMissions(state)[0]?.mission.id : rest.slice('mission:'.length);
        return (e) => MISSION_QUESTION_TYPES(e.type) && (missionId === undefined || e.mission_id === missionId);
      }
      return ofTask(rest, QUESTION_TYPES);
    }
    case 'reply':
      return ofTask(rest, REPLY_TYPES);
    case 'dep': {
      const [producer, consumer] = rest.split('->');
      if (!producer || !consumer) return undefined;
      return (e) => (e.task_id === producer || e.task_id === consumer) && DEPENDENCY_TYPES(e.type);
    }
    default:
      return undefined;
  }
}

export function storyFor(ref: GraphObjectRef, graph: Graph, state: State, events: Iterable<Event>): string[] {
  const pred = predicateFor(ref, graph, state);
  if (!pred) return [];
  return [...events]
    .filter(pred)
    .sort((a, b) => a.seq - b.seq)
    .map((e) => `${e.ts.slice(11, 16)} ${narrate(e, state)}`);
}
