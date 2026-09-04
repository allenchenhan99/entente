/** Test helper: a Hono app with the pty routes on an ephemeral port, plus the `ws` upgrade handler. */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { WebSocket } from 'ws';
import type { PtyServerMessage } from '@relay/protocol';
import { mountPty } from '../http/pty.js';
import type { RelayHost } from './host.js';

export interface TestServer {
  url: string;
  wsUrl: string;
  close(): Promise<void>;
  /** Opens a client on `/pty/:id`, collecting parsed frames; `next` waits for the next frame of a given type. */
  client(paneId: string): Promise<TestClient>;
  json<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }>;
}

export interface TestClient {
  ws: WebSocket;
  frames: PtyServerMessage[];
  /** Waits until `count` frames of type `t` have arrived (from the start), returns them. */
  frames_of<T extends PtyServerMessage['t']>(t: T, count?: number, timeoutMs?: number): Promise<Extract<PtyServerMessage, { t: T }>[]>;
  /** Concatenated decoded text of every `output` frame so far. */
  output(): string;
  send(msg: unknown): void;
  close(): Promise<void>;
}

export async function startTestServer(host: RelayHost): Promise<TestServer> {
  const app = new Hono();
  const { handleUpgrade } = mountPty(app, host);
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  server.on('upgrade', handleUpgrade);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const clients: WebSocket[] = [];
  return {
    url,
    wsUrl,
    async close() {
      for (const c of clients) c.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async json(method, path, body) {
      const res = await fetch(`${url}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: parsed as never, text };
    },
    async client(paneId) {
      const ws = new WebSocket(`${wsUrl}/pty/${paneId}`);
      clients.push(ws);
      const frames: PtyServerMessage[] = [];
      const waiters = new Set<() => void>();
      ws.on('message', (data) => {
        frames.push(JSON.parse(data.toString()) as PtyServerMessage);
        for (const w of waiters) w();
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) => reject(new Error(`unexpected response ${res.statusCode}`)));
      });
      const client: TestClient = {
        ws,
        frames,
        frames_of: (t, count = 1, timeoutMs = 15_000) => new Promise((resolve, reject) => {
          const pick = () => frames.filter((f) => f.t === t) as never[];
          const check = () => {
            if (pick().length >= count) {
              waiters.delete(check);
              clearTimeout(timer);
              resolve(pick());
            }
          };
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error(`no ${count} ${t} frame(s) within ${timeoutMs} ms; got ${JSON.stringify(frames.map((f) => f.t))}`));
          }, timeoutMs);
          waiters.add(check);
          check();
        }),
        output: () => frames.filter((f): f is Extract<PtyServerMessage, { t: 'output' }> => f.t === 'output').map((f) => Buffer.from(f.data, 'base64').toString('utf8')).join(''),
        send: (msg) => ws.send(JSON.stringify(msg)),
        close: () => new Promise((resolve) => { ws.once('close', () => resolve()); ws.close(); }),
      };
      return client;
    },
  };
}
