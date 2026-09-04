/**
 * relayd session token for the TUI (docs/security.md). Resolved once at startup from `--token`, then
 * `RELAY_TOKEN`, then `<relayDir>/session.token` (relayDir = `RELAY_DIR`, else `<RELAY_REPO | cwd>/.relay`).
 * The token rides on the injected `fetch` so every request — `/state`, `/events*`, and the command POSTs —
 * carries `Authorization: Bearer <token>`.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { FetchLike } from '../context.js';

const SESSION_TOKEN_FILE = 'session.token';

export interface TokenSources {
  flag?: string;
  env: Record<string, string | undefined>;
  cwd: string;
}

export function resolveSessionToken(sources: TokenSources): string | undefined {
  if (sources.flag) return sources.flag;
  const fromEnv = sources.env.RELAY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const relayDir = sources.env.RELAY_DIR
    ? path.resolve(sources.cwd, sources.env.RELAY_DIR)
    : path.join(path.resolve(sources.cwd, sources.env.RELAY_REPO ?? '.'), '.relay');
  try {
    const token = fs.readFileSync(path.join(relayDir, SESSION_TOKEN_FILE), 'utf8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/** A fetch that adds `Authorization: Bearer <token>` to every request; the identity when there is no token. */
export function withSessionToken(fetcher: FetchLike, token: string | undefined): FetchLike {
  if (!token) return fetcher;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetcher(input, { ...init, headers });
  };
}
