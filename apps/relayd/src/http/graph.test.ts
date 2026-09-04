import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionsFor, buildGraph, describe as describeObject, initialState, routes, storyFor } from '@relay/protocol';
import type { GraphObjectRef } from '@relay/protocol';
import { createTestRelay } from '../fakes/test-harness.js';
import { createSessionAuth } from '../auth/token.js';
import { createApp } from './app.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

/** A relayd app whose store was opened on the first `lines` events of a fixture (all of them by default). */
function setup(fixture?: string, opts: { lines?: number; auth?: 'optional' | 'required' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  if (fixture) {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf8').split('\n').filter((l) => l.trim());
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'run', 'events.jsonl'), text.slice(0, opts.lines ?? text.length).join('\n') + '\n');
  }
  const r = createTestRelay({ dir });
  const auth = opts.auth ? createSessionAuth({ relayDir: path.join(dir, '.relay'), mode: opts.auth }) : undefined;
  const app = createApp({ orchestrator: r.orchestrator, store: r.store, withMcp: false, auth });
  return { ...r, app, auth };
}

const get = async (app: ReturnType<typeof createApp>, url: string) => {
  const res = await app.request(url);
  return { status: res.status, body: (await res.json()) as any };
};

describe('GET /graph', () => {
  it('returns buildGraph(state) plus the last event seq for the live-1 fixture', async () => {
    const { app, store } = setup('events-live-1.jsonl');
    const { status, body } = await get(app, '/graph');
    expect(status).toBe(200);
    const graph = buildGraph(store.state());
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(body).toEqual({ ...JSON.parse(JSON.stringify(graph)), seq: store.state().last_seq });
    expect(body.seq).toBe(store.all().at(-1)!.seq);
  });

  it('returns the empty graph with seq 0 on an empty store', async () => {
    const { app } = setup();
    const { status, body } = await get(app, '/graph');
    expect(status).toBe(200);
    expect(body).toEqual({ ...buildGraph(initialState()), seq: 0 });
  });
});

describe('graph object', () => {
  const kinds = ['describe', 'actions', 'story'] as const;

  async function expectMatchesPureFunctions(fixture: string, lines: number | undefined, ref: GraphObjectRef) {
    const { app, store } = setup(fixture, { lines });
    const state = store.state();
    const graph = buildGraph(state);
    const base = routes.graphObject(ref.kind, ref.id);
    const [d, a, s] = await Promise.all(kinds.map((k) => get(app, `${base}/${k}`)));
    expect(d.status, 'describe').toBe(200);
    expect(d.body).toEqual(describeObject(ref, graph, state));
    expect(a.status, 'actions').toBe(200);
    expect(a.body).toEqual(actionsFor(ref, graph, state));
    expect(s.status, 'story').toBe(200);
    const story = storyFor(ref, graph, state, store.all());
    expect(story.length).toBeGreaterThan(0);
    expect(s.body).toEqual({ ref, lines: story.slice(-50) });
  }

  it('node: describe, actions and story equal the pure functions', async () => {
    await expectMatchesPureFunctions('events-live-1.jsonl', undefined, { kind: 'node', id: 't-backend-auth' });
  });

  it('edge (id with ":", URL-encoded): describe, actions and story equal the pure functions', async () => {
    expect(routes.graphObject('edge', 'contract:t-backend-auth')).toContain('%3A');
    await expectMatchesPureFunctions('events-live-1.jsonl', undefined, { kind: 'edge', id: 'contract:t-backend-auth' });
  });

  it('inbox item: describe, actions and story equal the pure functions', async () => {
    const { store } = setup('events-repair.jsonl', { lines: 11 });
    const graph = buildGraph(store.state());
    expect(graph.inbox.map((i) => i.kind)).toEqual(expect.arrayContaining(['lint_error', 'task_question']));
    for (const item of graph.inbox) {
      await expectMatchesPureFunctions('events-repair.jsonl', 11, { kind: 'inbox', id: item.id });
    }
  });

  it('story?limit=N returns the last N lines in seq order; default 50, max 500, bad values → 400', async () => {
    const { app, store } = setup('events-live-1.jsonl');
    const ref: GraphObjectRef = { kind: 'node', id: 't-backend-auth' };
    const state = store.state();
    const story = storyFor(ref, buildGraph(state), state, store.all());
    expect(story.length).toBeGreaterThan(3);
    const base = `${routes.graphObject(ref.kind, ref.id)}/story`;
    expect((await get(app, `${base}?limit=2`)).body).toEqual({ ref, lines: story.slice(-2) });
    expect((await get(app, `${base}?limit=1`)).body.lines).toEqual([story.at(-1)]);
    expect((await get(app, `${base}?limit=9999`)).body.lines).toEqual(story.slice(-500));
    expect((await get(app, base)).body.lines).toEqual(story.slice(-50));
    for (const bad of ['0', '-1', 'x', '1.5']) {
      const res = await get(app, `${base}?limit=${bad}`);
      expect(res.status, `limit=${bad}`).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining('limit') });
    }
  });

  it('a story longer than the limit is a suffix of the narrated events, oldest first', async () => {
    const { app, store } = setup('events-live-1.jsonl');
    const ref: GraphObjectRef = { kind: 'node', id: 'planner' };
    const { body } = await get(app, `${routes.graphObject(ref.kind, ref.id)}/story?limit=3`);
    const state = store.state();
    const full = storyFor(ref, buildGraph(state), state, store.all());
    expect(body.lines).toHaveLength(Math.min(3, full.length));
    expect(full.join('\n')).toMatch(new RegExp(body.lines.map((l: string) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\n') + '$'));
  });

  it('unknown kind → 400; unknown id → 404 { error: "object not found" }', async () => {
    const { app } = setup('events-live-1.jsonl');
    for (const k of kinds) {
      const bad = await get(app, `/graph/task/t-backend-auth/${k}`);
      expect(bad.status, k).toBe(400);
      expect(bad.body).toEqual({ error: expect.stringContaining('kind') });
      for (const [kind, id] of [['node', 't-nope'], ['edge', 'contract:t-nope'], ['inbox', 'lint_error:t-nope'], ['edge', 't-backend-auth']] as const) {
        const missing = await get(app, `${routes.graphObject(kind, id)}/${k}`);
        expect(missing.status, `${kind}/${id}/${k}`).toBe(404);
        expect(missing.body).toEqual({ error: 'object not found' });
      }
    }
  });
});
