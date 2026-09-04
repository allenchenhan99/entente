/**
 * HTTP surface of the relay terminal host (PRD §23, `ptyRoutes` in @relay/protocol pty.ts): pane listing,
 * screen snapshots, input, wait-output long-poll, readiness, kill, focus, cast download, plus the WebSocket
 * upgrade handler for `/pty/:id`. `layouts` and `app` belong to the web app package.
 */
import fs from 'node:fs';
import type { Hono, Context } from 'hono';
import type { z } from 'zod';
import { PaneInputBody, WaitOutputBody, ReadScreenQuery, ptyRoutes } from '@relay/protocol';
import type { RelayHost } from '../pty/host.js';
import { PaneNotFoundError } from '../pty/host.js';
import { UnknownKeyError } from '../pty/keys.js';
import { createPtyWebSocketServer, type PtyUpgradeHandler } from '../pty/ws.js';
import { sessionGuard, type SessionAuth } from '../auth/token.js';

const issues = (list: z.core.$ZodIssue[]): string[] =>
  list.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(body)'}: ${i.message}`);

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ errors: ['(body): invalid JSON'] }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, res: c.json({ errors: issues(parsed.error.issues) }, 400) };
  return { ok: true, data: parsed.data };
}

const notFound = (c: Context, paneId: string) => c.json({ error: `pane ${paneId} not found` }, 404);

export interface MountPtyOptions {
  /** Session token required on every pane route and on the WebSocket upgrade (docs/security.md). */
  auth?: SessionAuth;
}

export function mountPty(app: Hono, host: RelayHost, options: MountPtyOptions = {}): { handleUpgrade: PtyUpgradeHandler } {
  if (options.auth) {
    const guard = sessionGuard(options.auth);
    app.use(ptyRoutes.panes, guard);
    app.use(`${ptyRoutes.panes}/*`, guard);
  }
  const id = (c: Context): string => c.req.param('id') ?? '';
  /** Runs `fn` for a known pane; 404 otherwise. */
  const withPane = async (c: Context, fn: (paneId: string) => Response | Promise<Response>): Promise<Response> => {
    const paneId = id(c);
    if (!host.get(paneId)) return notFound(c, paneId);
    try {
      return await fn(paneId);
    } catch (err) {
      if (err instanceof PaneNotFoundError) return notFound(c, paneId);
      throw err;
    }
  };

  app.get(ptyRoutes.panes, (c) => {
    const focused = host.focusedPane;
    return c.json(focused === undefined ? { panes: host.list() } : { panes: host.list(), focused_pane: focused });
  });

  app.get(ptyRoutes.pane(':id'), (c) => withPane(c, (paneId) => c.json(host.get(paneId)!.info())));

  app.post(`${ptyRoutes.pane(':id')}/kill`, (c) => withPane(c, async (paneId) => {
    await host.kill(paneId);
    return c.json({ ok: true });
  }));

  app.post(`${ptyRoutes.pane(':id')}/focus`, (c) => withPane(c, async (paneId) => {
    await host.focus(paneId);
    return c.json({ ok: true });
  }));

  app.get(ptyRoutes.cast(':id'), (c) => withPane(c, (paneId) => {
    const file = host.get(paneId)!.castPath;
    if (!fs.existsSync(file)) return c.json({ error: `cast for ${paneId} not found` }, 404);
    return c.body(fs.readFileSync(file, 'utf8'), 200, { 'content-type': 'text/plain; charset=utf-8' });
  }));

  app.get(ptyRoutes.screen(':id'), (c) => withPane(c, (paneId) => {
    const rawLines = c.req.query('lines');
    const query = ReadScreenQuery.safeParse({ source: c.req.query('source'), lines: rawLines === undefined ? undefined : Number(rawLines) });
    if (!query.success) return c.json({ errors: issues(query.error.issues) }, 400);
    return c.json(host.snapshot(paneId, query.data));
  }));

  app.post(ptyRoutes.input(':id'), (c) => withPane(c, async (paneId) => {
    const body = await parseBody(c, PaneInputBody);
    if (!body.ok) return body.res;
    try {
      host.input(paneId, body.data);
    } catch (err) {
      if (err instanceof UnknownKeyError) return c.json({ errors: [`keys: ${err.message}`] }, 400);
      throw err;
    }
    return c.json({ ok: true });
  }));

  app.post(ptyRoutes.waitOutput(':id'), (c) => withPane(c, async (paneId) => {
    const body = await parseBody(c, WaitOutputBody);
    if (!body.ok) return body.res;
    if (body.data.match === undefined && body.data.regex === undefined) return c.json({ errors: ['(body): match or regex is required'] }, 400);
    if (body.data.regex !== undefined) {
      try {
        new RegExp(body.data.regex);
      } catch (err) {
        return c.json({ errors: [`regex: ${(err as Error).message}`] }, 400);
      }
    }
    return c.json(await host.waitOutput(paneId, body.data));
  }));

  app.get(ptyRoutes.readiness(':id'), (c) => withPane(c, (paneId) => c.json(host.readiness(paneId)!)));

  const { handleUpgrade } = createPtyWebSocketServer(host, { auth: options.auth });
  return { handleUpgrade };
}
