import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionsFor, buildGraph, describe as describeObject, initialState, narrate, reduce, routes, storyFor } from '@relay/protocol';
import type { Event, GraphObjectRef } from '@relay/protocol';
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

describe('GET /story', () => {
  interface StoryItem { seq: number; ts: string; task_id?: string; actor: string; line: string }

  /** What the Ink TUI timeline shows: every event narrated against the state *after* it, in one replay. */
  function narrated(events: Event[]): StoryItem[] {
    let state = initialState();
    return events.map((e) => {
      state = reduce(state, e);
      return { seq: e.seq, ts: e.ts, ...(e.task_id !== undefined ? { task_id: e.task_id } : {}), actor: e.actor, line: narrate(e, state) };
    });
  }

  it('narrates the whole log in seq order with the post-event state (default limit 200)', async () => {
    const { app, store } = setup('events-live-1.jsonl');
    const { status, body } = await get(app, '/story');
    expect(status).toBe(200);
    const expected = narrated(store.all());
    expect(expected.length).toBe(38);
    expect(body).toEqual({ items: expected });
    expect(body.items.map((i: StoryItem) => i.seq)).toEqual([...body.items.map((i: StoryItem) => i.seq)].sort((a, b) => a - b));
    expect(Object.keys(body.items[0])).toEqual(['seq', 'ts', 'actor', 'line']);
    expect(Object.keys(body.items[1])).toEqual(['seq', 'ts', 'task_id', 'actor', 'line']);
  });

  it('since= excludes the given seq and limit= pages; seq gaps in the log are skipped', async () => {
    const { app, store } = setup('events-live-1.jsonl');
    const all = narrated(store.all());
    expect(all.map((i) => i.seq)).toContain(13);
    expect(all.map((i) => i.seq)).not.toContain(14);
    const page1 = (await get(app, '/story?limit=5')).body.items as StoryItem[];
    expect(page1).toEqual(all.slice(0, 5));
    const page2 = (await get(app, `/story?since=${page1.at(-1)!.seq}&limit=5`)).body.items as StoryItem[];
    expect(page2).toEqual(all.slice(5, 10));
    expect((await get(app, '/story?since=13')).body.items).toEqual(all.filter((i) => i.seq > 13));
    expect((await get(app, '/story?since=14')).body.items).toEqual(all.filter((i) => i.seq > 14));
    expect((await get(app, '/story?since=41')).body).toEqual({ items: [] });
    expect((await get(app, '/story?since=0&limit=2000')).body.items).toEqual(all);
    expect((await get(app, '/story?limit=99999')).body.items).toEqual(all.slice(0, 2000));
  });

  it('rejects a non-integer since or a non-positive limit with 400', async () => {
    const { app } = setup('events-live-1.jsonl');
    for (const q of ['since=x', 'since=-1', 'since=1.5', 'limit=0', 'limit=-1', 'limit=x']) {
      const res = await get(app, `/story?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body).toEqual({ error: expect.stringContaining(q.split('=')[0]) });
    }
  });

  it('is empty on an empty store', async () => {
    const { app } = setup();
    expect((await get(app, '/story')).body).toEqual({ items: [] });
  });

  it('pins the live-1 narration to the lines the Ink TUI shows', async () => {
    const { app } = setup('events-live-1.jsonl');
    const { body } = await get(app, '/story');
    const lines = (body.items as StoryItem[]).map((i) => `${i.seq} ${i.line}`);
    expect(lines.slice(0, 13)).toEqual([
      '1 you create mission "Add secure login to this application." in /Users/allenchenhan99/entente-demo/app',
      '2 you propose t-backend-auth v1 to backend: "Implement secure login endpoints for this application, reusing the existing user model and session store" (5 criteria, paths src/auth/**, src/app.ts, tests/auth/**)',
      '3 RelayGraph lints t-backend-auth v1: clean',
      '4 RelayGraph creates worktree relay/t-backend-auth at /Users/allenchenhan99/entente-demo/app/.relay/wt/t-backend-auth',
      '5 RelayGraph spawns backend (claude-code) in pane wP:p9',
      '6 you propose t-frontend-login v1 to frontend: "Add a minimal login page that submits an email address to the backend login endpoint and shows the result" (2 criteria, paths public/**, tests/ui/**)',
      '7 RelayGraph lints t-frontend-login v1: clean',
      '8 RelayGraph creates worktree relay/t-frontend-login at /Users/allenchenhan99/entente-demo/app/.relay/wt/t-frontend-login',
      '9 RelayGraph spawns frontend (codex) in pane wP:pA',
      '10 you plan 2 tasks: t-backend-auth, t-frontend-login',
      '11 backend accepts v1 and restates it: Add passwordless email login: POST /auth/login takes an email, and when it matches a user in the existing UserRepo, gen…; Add POST /auth/verify that consumes the token: a valid, unexpired, never-used token creates a session in the existing S…; Replace the fixed 401 on GET /me with a real lookup: read the session cookie, look the session up in SessionStore, and…; Wire everything in src/app.ts through an options object with injectable UserRepo, SessionStore, LoginTokenStore, EmailS…; Cover all of this with vitest tests under tests/auth/, including tests/auth/valid-login.test.ts and tests/auth/expired-…',
      '12 backend starts working on t-backend-auth',
      '13 backend reports: "Contract accepted. Plan: passwordless email login token (single-use, expiring, hashed at rest) in src/auth/, POST /auth…" (5%)',
    ]);
    expect(lines.slice(-17)).toEqual([
      '25 you mark AC-3 failed — Manual test: after a successful POST /auth/verify with a token, replaying the exact same token a second time returned 2…',
      '26 RelayGraph opens repair r1 for AC-3 only (1 repair left)',
      '27 backend accepts repair r1',
      '28 backend is stuck: Repair r1 (AC-3) reports that replaying a consumed token returned 200 and created a second session. I cannot reproduce… (waiting on human reviewer: exact reproduction steps for the AC-3 token replay observation)',
      '29 you cancel t-frontend-login: codex config fixed; will rerun in the next mission',
      '30 backend resumes work',
      '31 backend reports: "Repair r1 (AC-3): replay could not be reproduced locally (sequential 200/401, concurrent 1x200+4x401). Added two regres…" (95%)',
      '32 backend submits evidence #2 claiming 5 passed: "Repair attempt for AC-3. Investigation showed the token replay cannot be reproduced on this branch: consume-and-delete…"',
      '33 RelayGraph starts checks on backend\'s attempt 2',
      '34 RelayGraph runs AC-1: passed',
      '35 RelayGraph runs AC-2: passed',
      '36 RelayGraph runs AC-4: passed',
      '37 RelayGraph runs AC-5: passed',
      '38 RelayGraph records attempt 2: 4 passed, 1 pending review',
      '39 you mark AC-3 passed',
      '40 RelayGraph verifies backend: every criterion of attempt 2 passed',
      '41 backend completes t-backend-auth',
    ]);
    expect(lines).toHaveLength(38);
  });
});

describe('graph auth', () => {
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  const endpoints = ['/graph', `${routes.graphObject('node', 't-backend-auth')}/describe`, `${routes.graphObject('edge', 'contract:t-backend-auth')}/story`, `${routes.graphObject('node', 'planner')}/actions`, '/story'];

  it('RELAY_AUTH=required: 401 without the session token, 200 with it (same as /state)', async () => {
    const { app, auth } = setup('events-live-1.jsonl', { auth: 'required' });
    for (const url of endpoints) {
      const missing = await app.request(url);
      expect(missing.status, url).toBe(401);
      expect(await missing.json()).toEqual({ error: expect.stringContaining('missing session token') });
      expect((await app.request(url, bearer('f'.repeat(32)))).status, url).toBe(401);
      expect((await app.request(url, bearer(auth!.token))).status, url).toBe(200);
    }
    expect((await app.request('/state')).status).toBe(401);
  });

  it('RELAY_AUTH=optional: the graph endpoints are open, like /state', async () => {
    const { app } = setup('events-live-1.jsonl', { auth: 'optional' });
    for (const url of endpoints) expect((await app.request(url)).status, url).toBe(200);
    expect((await app.request('/state')).status).toBe(200);
  });
});
