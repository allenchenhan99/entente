import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { MemoryEmailSender } from '../../src/email/stub.js';
import { UserRepo } from '../../src/models/user.js';
import { TOKEN_TTL_MS, TokenStore } from '../../src/auth/token-store.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const post = async (app: { request: (i: string, init?: RequestInit) => Response | Promise<Response> }, p: string, body: unknown, cookie?: string): Promise<Response> =>
  await app.request(p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

describe('P2 oracle — store and routes agree', () => {
  it('store: 15 min TTL, hashed at rest, single use', () => {
    expect(TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    let now = 0;
    const store = new TokenStore({ now: () => now });
    const raw = store.create('ada@example.com');
    expect(raw.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(store)).not.toContain(raw);
    expect(JSON.stringify(store)).toContain(sha256(raw).slice(0, 16));
    now += TOKEN_TTL_MS - 1;
    expect(store.consume(raw)).toBe('ada@example.com');
    expect(store.consume(raw)).toBeUndefined();
  });

  it('routes drive the real store end to end', async () => {
    let now = Date.parse('2026-09-05T00:00:00Z');
    const emails = new MemoryEmailSender();
    const app = createApp({ users: new UserRepo(), emails, now: () => now });
    const req = await post(app, '/auth/request', { email: 'ada@example.com' });
    expect(req.status).toBe(202);
    expect(emails.sent).toHaveLength(1);
    const token = decodeURIComponent(/token=([^&\s"]+)/.exec(emails.sent[0]!.text)![1]!);
    const ok = await post(app, '/auth/verify', { token });
    expect(ok.status).toBe(200);
    const cookie = /session=([^;]+)/.exec(ok.headers.get('set-cookie') ?? '');
    expect(cookie).not.toBeNull();
    const me = await app.request('/me', { headers: { cookie: `session=${cookie![1]}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'ada@example.com' });
    expect((await post(app, '/auth/verify', { token })).status).toBe(401);
    expect((await post(app, '/auth/request', { email: 'nobody@example.com' })).status).toBe(202);
    expect(emails.sent).toHaveLength(1);
  });
});
