import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createSessionAuth, type SessionAuth } from '../auth/token.js';
import { mountPtyProxy } from './pty-proxy.js';

const TERMD_TOKEN = 'ab'.repeat(16);
const CAST = '{"version":2,"width":120,"height":40}\n[0.011,"o","hi\\r\\n"]\n';

type Frame = { t: string; [k: string]: unknown };

interface Recorded { method: string; path: string; auth?: string; protocol?: string; body?: unknown }

/**
 * Fake termd: an in-process Hono + `ws` server with canned data that records every request (HTTP and WS
 * upgrade) and every client WS frame, and requires `Authorization: Bearer <termd token>` / `relay.<token>`.
 */
async function startFakeTermd() {
  const requests: Recorded[] = [];
  const wsFrames: unknown[] = [];
  const upstreamSockets: WebSocket[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    const auth = c.req.header('authorization');
    let body: unknown;
    if (c.req.method === 'POST') {
      const text = await c.req.text();
      body = text ? JSON.parse(text) : undefined;
    }
    requests.push({ method: c.req.method, path: c.req.path + (new URL(c.req.url).search), auth, body });
    if (auth !== `Bearer ${TERMD_TOKEN}`) return c.json({ error: 'invalid session token' }, 401);
    return next();
  });
  const pane = { pane_id: 'relay:1', role: 'backend', task_id: 't-1', cwd: '/w', pid: 7, alive: true, cols: 120, rows: 40, started_at: '2026-09-05T00:00:00.000Z', timings: { spawn_ms: 3 } };
  app.get('/panes', (c) => c.json({ panes: [pane], focused_pane: 'relay:1' }));
  app.post('/panes', (c) => c.json({ pane_id: 'relay:2' }, 201));
  app.get('/panes/:id', (c) => (c.req.param('id') === 'relay:1' ? c.json(pane) : c.json({ error: 'pane not found' }, 404)));
  app.get('/panes/:id/screen', (c) => c.json({ pane_id: 'relay:1', cols: 120, rows: 40, lines: ['a', 'b'], cursor: { x: 0, y: 1 }, alternate: false, scrollback_lines: 3, source: c.req.query('source'), lines_q: c.req.query('lines') }));
  app.post('/panes/:id/input', (c) => c.json({ ok: true }));
  app.post('/panes/:id/wait-output', (c) => c.json({ status: 'matched', line: 'done', at: '2026-09-05T00:00:01.000Z' }));
  app.post('/panes/:id/kill', (c) => c.json({ ok: true }));
  app.post('/panes/:id/resize', (c) => c.json({ errors: ['cols: expected positive int'] }, 400));
  app.get('/panes/:id/cast', (c) => (c.req.param('id') === 'relay:1' ? c.body(CAST, 200, { 'content-type': 'text/plain; charset=utf-8' }) : c.json({ error: 'cast not found' }, 404)));
  app.get('/metrics', (c) => c.json({ host: 'relayterm', uptime_ms: 5, panes_spawned: 1, panes_alive: 1, prompt_failures: 0, panes: [{ pane_id: 'relay:1', role: 'backend', timings: {} }] }));
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const protocol = req.headers['sec-websocket-protocol'];
    requests.push({ method: 'UPGRADE', path: req.url ?? '', protocol });
    const refuse = (status: number) => { socket.write(`HTTP/1.1 ${status} X\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    if (protocol !== `relay.${TERMD_TOKEN}`) return refuse(401);
    if (req.url !== '/pty/relay:1') return refuse(404);
    wss.handleUpgrade(req, socket, head, (ws) => {
      upstreamSockets.push(ws);
      ws.send(JSON.stringify({ t: 'hello', pane }));
      ws.send(JSON.stringify({ t: 'scrollback', data: Buffer.from('old').toString('base64') }));
      ws.send(JSON.stringify({ t: 'output', data: Buffer.from('new').toString('base64') }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { t: string };
        wsFrames.push(msg);
        if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
      });
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    wsFrames,
    upstreamSockets,
    close: () => new Promise<void>((resolve) => { for (const s of upstreamSockets) s.terminate(); server.close(() => resolve()); }),
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(options: { auth?: boolean } = { auth: true }) {
  const termd = await startFakeTermd();
  const auth: SessionAuth | undefined = options.auth === false ? undefined : createSessionAuth({ relayDir: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')), mode: 'optional' });
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  const { handleUpgrade } = mountPtyProxy(app, { baseUrl: termd.baseUrl, token: TERMD_TOKEN, auth });
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  server.on('upgrade', handleUpgrade);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const s of sockets) s.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await termd.close();
  });
  const bearer = { authorization: `Bearer ${auth?.token ?? ''}` };
  const get = (p: string, headers: Record<string, string> = bearer) => fetch(`${url}${p}`, { headers });
  const post = (p: string, body?: unknown, headers: Record<string, string> = bearer) =>
    fetch(`${url}${p}`, { method: 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  /**
   * Opens a WS client on relayd's `/pty/:id`, collecting frames from the start (ws flushes frames that arrived
   * with the 101 on `nextTick`, before any promise continuation); resolves on open, or with the refusal status.
   */
  const connect = (paneId: string, protocols?: string[]) => new Promise<{ ws: WebSocket; status?: number; frames: Frame[]; until: (n: number, timeoutMs?: number) => Promise<Frame[]> }>((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/pty/${paneId}`, protocols);
    sockets.push(ws);
    const frames: Frame[] = [];
    const waiters = new Set<() => void>();
    ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString()) as Frame); for (const w of waiters) w(); });
    const until = (n: number, timeoutMs = 5000) => new Promise<Frame[]>((res, rej) => {
      const timer = setTimeout(() => { waiters.delete(check); rej(new Error(`only ${frames.length} frames: ${JSON.stringify(frames.map((f) => f.t))}`)); }, timeoutMs);
      const check = () => { if (frames.length >= n) { waiters.delete(check); clearTimeout(timer); res(frames); } };
      waiters.add(check);
      check();
    });
    ws.once('open', () => resolve({ ws, frames, until }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode, frames, until }));
    ws.once('error', reject);
  });
  return { url, termd, auth, get, post, connect, bearer };
}

const waitFor = async (cond: () => boolean, what: string, timeoutMs = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('pty proxy', () => {
  it('GET /panes reaches termd with the termd token and returns its status + body verbatim', async () => {
    const { get, termd, auth } = await setup();
    const res = await get('/panes');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ panes: [expect.objectContaining({ pane_id: 'relay:1', task_id: 't-1' })], focused_pane: 'relay:1' });
    const seen = termd.requests.find((r) => r.method === 'GET' && r.path === '/panes');
    expect(seen?.auth).toBe(`Bearer ${TERMD_TOKEN}`);
    expect(seen?.auth).not.toBe(`Bearer ${auth!.token}`);
  });

  it('GET /panes/:id/screen?source=recent&lines=5 forwards the query string', async () => {
    const { get, termd } = await setup();
    const res = await get('/panes/relay:1/screen?source=recent&lines=5');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pane_id: 'relay:1', lines: ['a', 'b'], source: 'recent', lines_q: '5' });
    expect(termd.requests.some((r) => r.path === '/panes/relay:1/screen?source=recent&lines=5')).toBe(true);
  });

  it('POST /panes/:id/input and /wait-output stream the JSON body through', async () => {
    const { post, termd } = await setup();
    const input = await post('/panes/relay:1/input', { text: 'ls', keys: ['enter'] });
    expect(input.status).toBe(200);
    expect(await input.json()).toEqual({ ok: true });
    expect(termd.requests.find((r) => r.path === '/panes/relay:1/input')?.body).toEqual({ text: 'ls', keys: ['enter'] });
    const wait = await post('/panes/relay:1/wait-output', { match: 'done', timeout_ms: 100 });
    expect(wait.status).toBe(200);
    expect(await wait.json()).toEqual({ status: 'matched', line: 'done', at: '2026-09-05T00:00:01.000Z' });
    expect(termd.requests.find((r) => r.path === '/panes/relay:1/wait-output')?.body).toEqual({ match: 'done', timeout_ms: 100 });
  });

  it('GET /metrics passes termd\'s body through unchanged (host: relayterm)', async () => {
    const { get } = await setup();
    const res = await get('/metrics');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: 'relayterm', uptime_ms: 5, panes_spawned: 1, panes_alive: 1, prompt_failures: 0, panes: [{ pane_id: 'relay:1', role: 'backend', timings: {} }] });
  });

  it('GET /panes/:id/cast streams the cast bytes with termd\'s content-type', async () => {
    const { get } = await setup();
    const res = await get('/panes/relay:1/cast');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe(CAST);
  });

  it('preserves termd status codes: 404 unknown pane, 400 validation, 201 spawn', async () => {
    const { get, post } = await setup();
    const missing = await get('/panes/relay:9');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'pane not found' });
    const bad = await post('/panes/relay:1/resize', { cols: -1 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ errors: ['cols: expected positive int'] });
    const created = await post('/panes', { name: 'x', argv: ['sh'], cwd: '/w' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ pane_id: 'relay:2' });
  });

  it('requires relayd\'s own session token in front: 401 without it, and termd never sees the request', async () => {
    const { get, post, termd } = await setup();
    expect((await get('/panes', {})).status).toBe(401);
    expect((await get('/metrics', { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post('/panes/relay:1/input', { text: 'x' }, {})).status).toBe(401);
    expect(termd.requests).toHaveLength(0);
    expect((await get('/health', {})).status).toBe(200);
  });

  it('answers 502 when termd is unreachable', async () => {
    const app = new Hono();
    mountPtyProxy(app, { baseUrl: 'http://127.0.0.1:1', token: TERMD_TOKEN });
    const res = await app.request('/panes');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/termd unreachable/) });
  });
});

describe('pty proxy ws', () => {
  it('a client on /pty/relay:1 with relay.<session token> gets hello/scrollback/output from termd and its input reaches termd', async () => {
    const { connect, termd, auth } = await setup();
    const client = await connect('relay:1', [`relay.${auth!.token}`]);
    const { ws } = client;
    expect(client.status).toBeUndefined();
    expect(ws.protocol).toBe(`relay.${auth!.token}`);
    const frames = await client.until(3);
    expect(frames.map((f) => f.t)).toEqual(['hello', 'scrollback', 'output']);
    expect(frames[0]!.pane).toMatchObject({ pane_id: 'relay:1' });
    expect(Buffer.from(frames[2]!.data as string, 'base64').toString()).toBe('new');
    // termd saw the upgrade with its own token, not relayd's.
    const upgrade = termd.requests.find((r) => r.method === 'UPGRADE');
    expect(upgrade).toMatchObject({ path: '/pty/relay:1', protocol: `relay.${TERMD_TOKEN}` });
    ws.send(JSON.stringify({ t: 'input', data: Buffer.from('ls\r').toString('base64') }));
    ws.send(JSON.stringify({ t: 'ping' }));
    await waitFor(() => termd.wsFrames.length >= 2, 'input frames at termd');
    expect(termd.wsFrames).toEqual([{ t: 'input', data: Buffer.from('ls\r').toString('base64') }, { t: 'ping' }]);
    expect((await client.until(4))[3]).toEqual({ t: 'pong' });
  });

  it('refuses without the session token (401) and for an unknown pane (404) before the upgrade', async () => {
    const { connect, termd, auth } = await setup();
    expect((await connect('relay:1')).status).toBe(401);
    expect((await connect('relay:1', ['relay.wrong'])).status).toBe(401);
    expect(termd.requests).toHaveLength(0);
    expect((await connect('relay:9', [`relay.${auth!.token}`])).status).toBe(404);
    // The pane was probed over HTTP; no upstream socket was opened.
    expect(termd.requests.map((r) => r.method)).toEqual(['GET']);
    expect(termd.requests[0]!.path).toBe('/panes/relay:9');
  });

  it('closing the client closes the upstream socket, and closing upstream closes the client', async () => {
    const { connect, termd, auth } = await setup();
    const a = await connect('relay:1', [`relay.${auth!.token}`]);
    await a.until(3);
    const b = await connect('relay:1', [`relay.${auth!.token}`]);
    await b.until(3);
    expect(termd.upstreamSockets).toHaveLength(2);
    const closedA = new Promise<void>((resolve) => a.ws.once('close', () => resolve()));
    a.ws.close();
    await closedA;
    await waitFor(() => termd.upstreamSockets[0]!.readyState === WebSocket.CLOSED, 'upstream a closed');
    expect(termd.upstreamSockets[1]!.readyState).toBe(WebSocket.OPEN);
    const closedB = new Promise<number>((resolve) => b.ws.once('close', (code) => resolve(code)));
    termd.upstreamSockets[1]!.close(1000, 'bye');
    expect(await closedB).toBe(1000);
  });
});
