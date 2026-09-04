/**
 * Graph object model over HTTP (`routes.graph`, `routes.graphObject`, `routes.story` in `@relay/protocol` api.ts):
 * pure read endpoints that hand clients without the TypeScript reducer (the Rust relay-tui) exactly what the
 * Ink TUI computes locally — `buildGraph`, `describe`, `storyFor`, `actionsFor` and the narrated event log.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { actionsFor, buildGraph, describe, initialState, narrate, reduce, routes, storyFor } from '@relay/protocol';
import type { Graph, GraphObjectRef } from '@relay/protocol';
import type { EventStore } from '../ports.js';
import { INVALID_TOKEN, MISSING_TOKEN, bearerToken, isGuardedPath, verifySessionToken, type SessionAuth } from '../auth/token.js';

export interface GraphDeps {
  store: EventStore;
  /**
   * Session-token guard: the graph endpoints are guarded exactly when `/state` is (open in `optional` mode,
   * token required in `required` mode). Omitted → open (library use in tests).
   */
  auth?: SessionAuth;
}

const OBJECT_KINDS: readonly GraphObjectRef['kind'][] = ['node', 'edge', 'inbox'];
const isObjectKind = (kind: string): kind is GraphObjectRef['kind'] => (OBJECT_KINDS as readonly string[]).includes(kind);

/** Object story window: default 50 lines, capped at 500. */
const STORY_LIMIT = { default: 50, max: 500 } as const;
/** Narrated log page: default 200 events, capped at 2000. */
const LOG_LIMIT = { default: 200, max: 2000 } as const;

/** Non-negative integer `since` (exclusive cursor, default 0); `undefined` when the raw value is invalid. */
function parseSince(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** One narrated event of `GET /story`: `line = narrate(event, stateAfterEvent)`. */
export interface StoryItem {
  seq: number;
  ts: string;
  task_id?: string;
  actor: string;
  line: string;
}

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
  const { store, auth } = deps;

  if (auth && isGuardedPath(routes.state, auth.mode)) {
    const guard: MiddlewareHandler = async (c, next) => {
      const presented = bearerToken(c.req.header('authorization'));
      if (presented === undefined) return c.json({ error: MISSING_TOKEN }, 401);
      if (!verifySessionToken(auth, presented)) return c.json({ error: INVALID_TOKEN }, 401);
      return next();
    };
    app.use(routes.graph, guard);
    app.use(`${routes.graph}/*`, guard);
    app.use(routes.story, guard);
  }

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

  app.get(routes.story, (c) => {
    const since = parseSince(c.req.query('since'));
    if (since === undefined) return c.json({ error: 'since must be a non-negative integer' }, 400);
    const limit = parseLimit(c.req.query('limit'), LOG_LIMIT);
    if (limit === undefined) return c.json({ error: `limit must be a positive integer (max ${LOG_LIMIT.max})` }, 400);
    // One incremental replay over the whole log: every event is narrated against the state *after* it, exactly as
    // the Ink TUI timeline does. Events at or before `since` still have to be reduced, only not emitted.
    const items: StoryItem[] = [];
    let state = initialState();
    for (const event of store.all()) {
      state = reduce(state, event);
      if (event.seq <= since) continue;
      items.push({ seq: event.seq, ts: event.ts, ...(event.task_id !== undefined ? { task_id: event.task_id } : {}), actor: event.actor, line: narrate(event, state) });
      if (items.length >= limit) break;
    }
    return c.json({ items });
  });
}
