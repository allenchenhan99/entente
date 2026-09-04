/**
 * STUB — the protocol agent replaces this with the full reducer (see docs/plans contract `protocol`).
 * Contract: pure, total, idempotent on seq (events with seq <= state.last_seq are ignored).
 */
import type { Event } from './events.js';
import type { State } from './state.js';
import { initialState } from './state.js';

export function reduce(state: State, event: Event): State {
  if (event.seq <= state.last_seq) return state;
  return { ...state, last_seq: event.seq };
}

export function replay(events: Iterable<Event>, from: State = initialState()): State {
  let s = from;
  for (const e of events) s = reduce(s, e);
  return s;
}
