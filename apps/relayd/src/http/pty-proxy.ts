/**
 * Reverse proxy from relayd to the Rust `termd` (docs/relay-term-spec.md §10): `GET/POST /panes*` and
 * `GET /metrics` are forwarded with the termd token (bodies streamed, status + body verbatim, so the `relay pane …`
 * CLI, the TUI and the web app keep using relayd's routes unchanged); the WebSocket `/pty/:id` is bridged
 * frame-for-frame to termd's. relayd's own session token guards everything in front (`sessionGuard`, the
 * `relay.<token>` subprotocol rule from `pty/ws.ts`); termd's token never leaves the daemon.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Hono, Context } from 'hono';
import { WebSocketServer, WebSocket } from 'ws';
import { ptyRoutes } from '@relay/protocol';
import { sessionGuard, upgradeToken, verifySessionToken, type SessionAuth } from '../auth/token.js';
import { paneIdFromUrl, type PtyUpgradeHandler } from '../pty/ws.js';
import type { PaneAnnotations } from '../pty/annotations.js';

export interface PtyProxyOptions {
  /** termd's `http://127.0.0.1:<port>` (from `RelaytermHost.start()`). */
  baseUrl: string;
  /** The token termd was started with (`--token`). */
  token: string;
  /** relayd's session token; when set, required on every proxied route and on the upgrade. */
  auth?: SessionAuth;
  /** What relayd knows about a pane that termd does not — see pty/annotations.ts. */
  annotations?: PaneAnnotations;
}

/** Headers that must not be copied between the two hops. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'host', 'authorization', 'content-length']);

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function mountPtyProxy(app: Hono, options: PtyProxyOptions): { handleUpgrade: PtyUpgradeHandler } {
  const base = options.baseUrl.replace(/\/$/, '');
  const wsBase = base.replace(/^http/, 'ws');
  const bearer = `Bearer ${options.token}`;

  if (options.auth) {
    const guard = sessionGuard(options.auth);
    app.use(ptyRoutes.panes, guard);
    app.use(`${ptyRoutes.panes}/*`, guard);
    app.use(ptyRoutes.metrics, guard);
  }

  const isPaneList = (body: unknown): body is { panes: Array<{ pane_id: string }> } =>
    typeof body === 'object' && body !== null && Array.isArray((body as { panes?: unknown }).panes);
  const isPane = (body: unknown): body is { pane_id: string } =>
    typeof body === 'object' && body !== null && typeof (body as { pane_id?: unknown }).pane_id === 'string';

  const forward = async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
    headers.set('authorization', bearer);
    const method = c.req.method;
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let upstream: Response;
    try {
      upstream = await fetch(`${base}${url.pathname}${url.search}`, {
        method, headers,
        body: hasBody ? c.req.raw.body : undefined,
        // Node requires this to stream a request body.
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit);
    } catch (err) {
      return c.json({ error: `termd unreachable at ${base}: ${(err as Error).message}` }, 502);
    }
    const out = new Headers();
    for (const [name, value] of upstream.headers) if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'content-encoding') out.set(name, value);
    // termd reports a pane as the shell it was spawned as; what it became — an agent the human ran in
    // it — is relayd's to know, so a listing is rewritten on the way back. Only listings: everything
    // else streams through untouched.
    const overlay = options.annotations;
    if (overlay && method === 'GET' && upstream.ok && upstream.headers.get('content-type')?.includes('json')) {
      const body = (await upstream.json()) as unknown;
      const patched = Array.isArray(body)
        ? overlay.applyAll(body as Array<{ pane_id: string }>)
        : isPaneList(body)
          ? { ...body, panes: overlay.applyAll(body.panes) }
          : isPane(body)
            ? overlay.apply(body)
            : body;
      out.delete('content-length');
      return new Response(JSON.stringify(patched), { status: upstream.status, headers: out });
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };

  app.all(ptyRoutes.panes, forward);

  app.all(`${ptyRoutes.panes}/*`, forward);
  app.get(ptyRoutes.metrics, forward);

  const wss = new WebSocketServer({ noServer: true });
  const handleUpgrade: PtyUpgradeHandler = (req, socket, head) => {
    if (options.auth && !verifySessionToken(options.auth, upgradeToken(req))) return refuse(socket, 401, 'Unauthorized');
    const paneId = paneIdFromUrl(req.url);
    if (paneId === undefined) return refuse(socket, 404, 'Not Found');
    void bridge(req, socket, head, paneId);
  };

  /** Probes the pane over HTTP (404 before the upgrade), then pipes a client socket to a termd socket. */
  const bridge = async (req: IncomingMessage, socket: Duplex, head: Buffer, paneId: string): Promise<void> => {
    let probe: Response;
    try {
      probe = await fetch(`${base}${ptyRoutes.pane(paneId)}`, { headers: { authorization: bearer } });
    } catch {
      return refuse(socket, 502, 'Bad Gateway');
    }
    if (probe.status === 404) return refuse(socket, 404, 'Not Found');
    if (probe.status !== 200) return refuse(socket, 502, 'Bad Gateway');
    if (socket.destroyed) return;

    const upstream = new WebSocket(`${wsBase}${ptyRoutes.pty(paneId)}`, [`relay.${options.token}`]);
    // Frames termd sends before the client side is attached (hello/scrollback arrive right after open).
    const pending: Array<{ data: Buffer | ArrayBuffer | Buffer[]; binary: boolean }> = [];
    let client: WebSocket | undefined;
    upstream.on('message', (data, isBinary) => {
      if (client && client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      else if (!client) pending.push({ data, binary: isBinary });
    });
    upstream.on('close', (code, reason) => {
      if (client && client.readyState === WebSocket.OPEN) client.close(portableCode(code), reason.toString());
    });
    upstream.on('unexpected-response', (_req, res) => {
      res.resume();
      if (!client) refuse(socket, res.statusCode ?? 502, res.statusMessage ?? 'Bad Gateway');
    });
    upstream.on('error', () => {
      if (!client) refuse(socket, 502, 'Bad Gateway');
      else if (client.readyState === WebSocket.OPEN) client.close(1011, 'termd connection failed');
    });
    upstream.once('open', () => {
      if (socket.destroyed) return upstream.close();
      wss.handleUpgrade(req, socket, head, (ws) => {
        client = ws;
        for (const frame of pending.splice(0)) ws.send(frame.data, { binary: frame.binary });
        ws.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        ws.on('close', (code, reason) => {
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(portableCode(code), reason.toString());
        });
        ws.on('error', () => upstream.terminate());
      });
    });
  };

  return { handleUpgrade };
}

/** Close codes a peer may not send onward (1005 no-status, 1006 abnormal) become a normal 1000. */
function portableCode(code: number): number {
  return code === 1005 || code === 1006 || code < 1000 ? 1000 : code;
}
