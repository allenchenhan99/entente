/**
 * STUB — replaced by the `graph-model` work package. Renderers may already import the types and call
 * these functions; until the real implementation lands they return empty results (never throw).
 */
import type { Event } from '../events.js';
import type { State } from '../state.js';
import type { Graph, GraphObjectRef, ObjectAction, ObjectDescription } from './types.js';

export * from './types.js';

export function buildGraph(_state: State): Graph {
  return { nodes: [], edges: [], inbox: [] };
}
export function actionsFor(_ref: GraphObjectRef, _graph: Graph, _state: State): ObjectAction[] {
  return [];
}
export function narrate(event: Event, _state: State): string {
  return `${event.actor} ${event.type}${event.task_id ? ` ${event.task_id}` : ''}`;
}
export function storyFor(_ref: GraphObjectRef, _graph: Graph, state: State, events: Iterable<Event>): string[] {
  return [...events].map((e) => narrate(e, state));
}
export function describe(ref: GraphObjectRef, _graph: Graph, _state: State): ObjectDescription {
  return { title: ref.id, lines: [] };
}
