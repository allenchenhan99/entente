/**
 * Graph object model over HTTP (`routes.graph`, `routes.graphObject`, `routes.story` in `@relay/protocol` api.ts):
 * pure read endpoints that hand clients without the TypeScript reducer (the Rust relay-tui) exactly what the
 * Ink TUI computes locally — `buildGraph`, `describe`, `storyFor`, `actionsFor` and the narrated event log.
 */
import type { Context, Hono } from 'hono';
import { actionsFor, buildGraph, describe, routes, storyFor } from '@relay/protocol';
import type { Graph, GraphObjectRef } from '@relay/protocol';
import type { EventStore } from '../ports.js';

export interface GraphDeps {
  store: EventStore;
}

const OBJECT_KINDS: readonly GraphObjectRef['kind'][] = ['node', 'edge', 'inbox'];
const isObjectKind = (kind: string): kind is GraphObjectRef['kind'] => (OBJECT_KINDS as readonly string[]).includes(kind);

/** Object story window: default 50 lines, capped at 500. */
const STORY_LIMIT = { default: 50, max: 500 } as const;

/** Positive integer `limit`, clamped to `max`; `undefined` when the raw value is not a positive integer. */
function parseLimit(raw: string | undefined, bounds: { default: number; max: number }): number | undefined {
  if (raw === undefined || raw === '') return bounds.default;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, bounds.max);
}

function objectExists(ref: GraphObjectRef, graph: Graph): boolean {
  switch (ref.kind) {
    case 'node':
      return graph.nodes.some((n) => n.id === ref.id);
    case 'edge':
      return graph.edges.some((e) => e.id === ref.id);
    case 'inbox':
      return graph.inbox.some((i) => i.id === ref.id);
  }
}

export function mountGraph(app: Hono, deps: GraphDeps): void {
  const { store } = deps;

  app.get(routes.graph, (c) => {
    const state = store.state();
    return c.json({ ...buildGraph(state), seq: state.last_seq });
  });

  /** Resolves `:kind/:id` (URL-decoded by Hono) against the current graph, or answers 400 / 404. */
  const withObject = (c: Context, handler: (ref: GraphObjectRef, graph: Graph) => Response): Response => {
    const kind = c.req.param('kind');
    if (kind === undefined || !isObjectKind(kind)) return c.json({ error: `kind must be one of ${OBJECT_KINDS.join(', ')}` }, 400);
    const ref: GraphObjectRef = { kind, id: c.req.param('id') ?? '' };
    const graph = buildGraph(store.state());
    if (!objectExists(ref, graph)) return c.json({ error: 'object not found' }, 404);
    return handler(ref, graph);
  };

  app.get('/graph/:kind/:id/describe', (c) => withObject(c, (ref, graph) => c.json(describe(ref, graph, store.state()))));
  app.get('/graph/:kind/:id/actions', (c) => withObject(c, (ref, graph) => c.json(actionsFor(ref, graph, store.state()))));
  app.get('/graph/:kind/:id/story', (c) => {
    const limit = parseLimit(c.req.query('limit'), STORY_LIMIT);
    if (limit === undefined) return c.json({ error: `limit must be a positive integer (max ${STORY_LIMIT.max})` }, 400);
    return withObject(c, (ref, graph) => c.json({ ref, lines: storyFor(ref, graph, store.state(), store.all()).slice(-limit) }));
  });
}
