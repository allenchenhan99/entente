/**
 * Per-daemon session token (docs/security.md). Generated at boot, printed once as `relayd token: …` and
 * written to `<relayDir>/session.token` (mode 0600). Clients send it as `Authorization: Bearer <token>`;
 * a WebSocket client sends it as the subprotocol `relay.<token>` (`Sec-WebSocket-Protocol`), which keeps
 * it out of URLs and logs.
 *
 * Two modes (`RELAY_AUTH`): `optional` (default) guards only the pane/pty/runs routes, so the existing MCP
 * agent flow — which authenticates with task tokens on `/mcp` — and the thin clients keep working;
 * `required` additionally guards /state, /events*, /missions* and /tasks*. `/health` and `/mcp` are never
 * guarded here. Task and planner MCP tokens are never accepted by this guard.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';

export type AuthMode = 'required' | 'optional';

export interface SessionAuth {
  token: string;
  /** `<relayDir>/session.token` */
  file: string;
  mode: AuthMode;
}

export const SESSION_TOKEN_FILE = 'session.token';

const ALWAYS_GUARDED = ['/panes', '/pty', '/runs', '/metrics'];
const GUARDED_WHEN_REQUIRED = ['/state', '/events', '/missions', '/tasks'];

export function generateSessionToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function parseAuthMode(raw: string | undefined): AuthMode {
  if (raw === undefined || raw === 'optional') return 'optional';
  if (raw === 'required') return 'required';
  throw new Error(`RELAY_AUTH must be required or optional, got ${raw}`);
}

export function createSessionAuth(options: { relayDir: string; mode: AuthMode }): SessionAuth {
  const token = generateSessionToken();
  const file = path.join(options.relayDir, SESSION_TOKEN_FILE);
  fs.mkdirSync(options.relayDir, { recursive: true });
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return { token, file, mode: options.mode };
}

const underPrefix = (pathname: string, prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isGuardedPath(pathname: string, mode: AuthMode): boolean {
  if (ALWAYS_GUARDED.some((prefix) => underPrefix(pathname, prefix))) return true;
  return mode === 'required' && GUARDED_WHEN_REQUIRED.some((prefix) => underPrefix(pathname, prefix));
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

/** The token a WebSocket client presented as the `relay.<token>` subprotocol. */
export function upgradeToken(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const raw = req.headers['sec-websocket-protocol'];
  const header = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  for (const entry of header.split(',')) {
    const protocol = entry.trim();
    if (protocol.startsWith('relay.') && protocol.length > 'relay.'.length) return protocol.slice('relay.'.length);
  }
  return undefined;
}

export function verifySessionToken(auth: SessionAuth, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(auth.token, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export const MISSING_TOKEN = 'missing session token: send Authorization: Bearer <relayd token>';
export const INVALID_TOKEN = 'invalid session token';

/** Hono middleware: 401 `{ error }` on guarded paths without a valid session token. */
export function sessionGuard(auth: SessionAuth): MiddlewareHandler {
  return async (c, next) => {
    if (!isGuardedPath(c.req.path, auth.mode)) return next();
    const presented = bearerToken(c.req.header('authorization'));
    if (presented === undefined) return c.json({ error: MISSING_TOKEN }, 401);
    if (!verifySessionToken(auth, presented)) return c.json({ error: INVALID_TOKEN }, 401);
    return next();
  };
}
