import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { WebSocket } from 'ws';
import { createSessionAuth, type SessionAuth } from '../auth/token.js';
import { createTestRelay, sampleContract } from '../fakes/test-harness.js';
import { createRelayHost } from '../pty/host.js';
import { createApp } from './app.js';
import { mountPty } from './pty.js';

const json = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function setup(mode: 'optional' | 'required' = 'optional') {
  const r = createTestRelay();
  const auth = createSessionAuth({ relayDir: path.join(r.dir, '.relay'), mode });
  const app = createApp({ orchestrator: r.orchestrator, store: r.store, pingIntervalMs: 20, auth });
  return { ...r, app, auth };
}

describe('session token on HTTP routes', () => {
  it('GET /panes and /runs: 401 without the token, 200 with Authorization: Bearer <token>', async () => {
    const { app, auth } = setup();
    const missing = await app.request('/runs');
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: expect.stringContaining('missing session token') });
    expect((await app.request('/runs', bearer(auth.token))).status).toBe(200);
    expect((await app.request('/runs/run-1/casts')).status).toBe(401);
    const badToken = await app.request('/runs', bearer('f'.repeat(32)));
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toEqual({ error: 'invalid session token' });
  });

  it('a task MCP token or the planner token is not a session token: 401 on pane routes', async () => {
    const { app, auth, orchestrator } = setup();
    const created = await app.request('/missions', json({ repo: '/repo', title: 'Add login' }));
    const { mission_id, planner_token } = (await created.json()) as { mission_id: string; planner_token: string };
    expect((await app.request(`/missions/${mission_id}/plan`, json({ tasks: [sampleContract('t-a')] }))).status).toBe(200);
    const taskToken = orchestrator.tokenFor('t-a');
    expect(taskToken).toMatch(/^[0-9a-f]{32}$/);
    expect((await app.request('/runs', bearer(taskToken!))).status).toBe(401);
    expect((await app.request('/runs', bearer(planner_token))).status).toBe(401);
    expect((await app.request('/runs', bearer(auth.token))).status).toBe(200);
  });

  it('RELAY_AUTH=optional (default): /state, /events/log, /missions, /tasks and /health stay open', async () => {
    const { app } = setup('optional');
    expect((await app.request('/state')).status).toBe(200);
    expect((await app.request('/events/log')).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/missions', json({ repo: '/repo', title: 'Open' }))).status).toBe(200);
    expect((await app.request('/tasks/t-none/reply', json({ message: 'hi' }))).status).toBe(404);
  });

  it('RELAY_AUTH=required: /state, /events*, /missions*, /tasks* need the token; /health and /mcp do not', async () => {
    const { app, auth } = setup('required');
    for (const route of ['/state', '/events/log', '/events']) {
      expect((await app.request(route)).status, route).toBe(401);
    }
    expect((await app.request('/missions', json({ repo: '/repo', title: 'Closed' }))).status).toBe(401);
    expect((await app.request('/tasks/t-none/reply', json({ message: 'hi' }))).status).toBe(401);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/state', bearer(auth.token))).status).toBe(200);
    expect((await app.request('/events/log', bearer(auth.token))).status).toBe(200);
    expect((await app.request('/missions', json({ repo: '/repo', title: 'Closed' }, auth.token))).status).toBe(200);
    // MCP authenticates with its own task/planner tokens; the session guard must not get in the way.
    const mcp = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(mcp.status).not.toBe(401);
  });

  it('createApp without auth (library use) leaves the routes open', async () => {
    const r = createTestRelay();
    const app = createApp({ orchestrator: r.orchestrator, store: r.store });
    expect((await app.request('/runs')).status).toBe(200);
  });
});

async function ptyServer(auth: SessionAuth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const host = createRelayHost({ relayDir: path.join(dir, '.relay'), runId: 'run-1', timings: { quietMs: 100, retryMs: 300, timeoutMs: 3000 } });
  const app = new Hono();
  const { handleUpgrade } = mountPty(app, host, { auth });
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  server.on('upgrade', handleUpgrade);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.killAll(50);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'read line; exit 0'], env: {} });
  return { url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, paneId };
}

/** Resolves with the HTTP status of a refused upgrade, or 'open' plus the first frame when accepted. */
function connect(url: string, protocols?: string[]): Promise<{ status: number } | { status: 'open'; first: unknown; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once('message', (data) => resolve({ status: 'open', first: JSON.parse(data.toString()), ws }));
    ws.once('error', (err) => reject(err));
    cleanups.push(() => { ws.close(); });
  });
}

describe('session token on the pty WebSocket and pane routes', () => {
  it('WS /pty/:id without the token → 401 before upgrade; with the relay.<token> subprotocol → hello', async () => {
    const auth = createSessionAuth({ relayDir: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')), mode: 'optional' });
    const { url, wsUrl, paneId } = await ptyServer(auth);

    const missing = await fetch(`${url}/panes`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: expect.stringContaining('missing session token') });
    const ok = await fetch(`${url}/panes`, bearer(auth.token));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { panes: unknown[] }).panes).toHaveLength(1);
    expect((await fetch(`${url}/panes/${paneId}/screen`)).status).toBe(401);

    expect(await connect(`${wsUrl}/pty/${paneId}`)).toEqual({ status: 401 });
    expect(await connect(`${wsUrl}/pty/${paneId}`, [`relay.${'f'.repeat(32)}`])).toEqual({ status: 401 });
    // An unknown pane is also refused with 401 (not 404) when no token is presented: no pane-id oracle.
    expect(await connect(`${wsUrl}/pty/relay:404`)).toEqual({ status: 401 });
    expect(await connect(`${wsUrl}/pty/relay:404`, [`relay.${auth.token}`])).toEqual({ status: 404 });

    const accepted = await connect(`${wsUrl}/pty/${paneId}`, [`relay.${auth.token}`]);
    expect(accepted.status).toBe('open');
    expect((accepted as { first: { t: string } }).first.t).toBe('hello');
  });
});
