/**
 * Graph object model — the explainable view of RelayGraph. Pure functions of `State` (+ events).
 * Interface: ./types.ts (frozen). Implementation: build / actions / narrate / story / describe.
 */
import type { Event } from '../events.js';
import type { State } from '../state.js';
import type { Graph, GraphObjectRef, ObjectDescription } from './types.js';

export * from './types.js';
export { buildGraph } from './build.js';
export { actionsFor } from './actions.js';
export { narrate } from './narrate.js';
import { narrate } from './narrate.js';

export function storyFor(_ref: GraphObjectRef, _graph: Graph, state: State, events: Iterable<Event>): string[] {
  return [...events].map((e) => narrate(e, state));
}
export function describe(ref: GraphObjectRef, _graph: Graph, _state: State): ObjectDescription {
  return { title: ref.id, lines: [] };
}
