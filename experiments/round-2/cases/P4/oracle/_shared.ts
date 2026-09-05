// Hidden oracle helpers for P4. Copied into <candidate>/tests/oracle/ at verification time; never shown to agents.
import { createApp } from '../../src/app.js';
import { MemoryEmailSender } from '../../src/email/stub.js';
import { UserRepo } from '../../src/models/user.js';

export function fixture(startMs = Date.parse('2026-09-05T00:00:00Z')) {
  let nowMs = startMs;
  const emails = new MemoryEmailSender();
  const users = new UserRepo();
  const app = createApp({ users, emails, now: () => nowMs });
  return { app, emails, users, advance: (ms: number) => { nowMs += ms; }, now: () => nowMs };
}

export const KNOWN = 'ada@example.com';
export const UNKNOWN = 'nobody@example.com';

type AppLike = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

export async function request(app: AppLike, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

export function cookieOf(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const m = /(?:^|,\s*)session=([^;]+)/.exec(raw);
  if (!m) throw new Error(`no session cookie in: ${raw}`);
  return `session=${m[1]}`;
}

export function cookieAttrs(res: Response): string {
  return res.headers.get('set-cookie') ?? '';
}
