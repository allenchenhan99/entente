/**
 * Graph object model over HTTP (`routes.graph`, `routes.graphObject`, `routes.story` in `@relay/protocol` api.ts):
 * pure read endpoints that hand clients without the TypeScript reducer (the Rust relay-tui) exactly what the
 * Ink TUI computes locally — `buildGraph`, `describe`, `storyFor`, `actionsFor` and the narrated event log.
 */
import type { Hono } from 'hono';
import { buildGraph, routes } from '@relay/protocol';
import type { EventStore } from '../ports.js';

export interface GraphDeps {
  store: EventStore;
}

export function mountGraph(app: Hono, deps: GraphDeps): void {
  const { store } = deps;

  app.get(routes.graph, (c) => {
    const state = store.state();
    return c.json({ ...buildGraph(state), seq: state.last_seq });
  });
}
