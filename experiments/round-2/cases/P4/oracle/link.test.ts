import { describe, expect, it } from 'vitest';
import { KNOWN, UNKNOWN, cookieAttrs, cookieOf, fixture, request } from './_shared.js';

const tokenFrom = (text: string): string => {
  const m = /[?&]token=([A-Za-z0-9._~%-]+)/.exec(text);
  if (!m) throw new Error(`no token url in email: ${text}`);
  return decodeURIComponent(m[1]!);
};

describe('P4 oracle — magic link (the product owner chose the link)', () => {
  it('request → 202, email holds a URL with a token; verify {token} → 200 + session cookie; /me works', async () => {
    const f = fixture();
    const res = await request(f.app, '/auth/request', { email: KNOWN });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(f.emails.sent).toHaveLength(1);
    const token = tokenFrom(f.emails.sent[0]!.text);
    const verified = await request(f.app, '/auth/verify', { token });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ email: KNOWN });
    const attrs = cookieAttrs(verified);
    expect(attrs).toMatch(/HttpOnly/i);
    expect(attrs).toMatch(/SameSite=Lax/i);
    const me = await f.app.request('/me', { headers: { cookie: cookieOf(verified) } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: KNOWN });
  });

  it('unknown email: identical 202 and no email', async () => {
    const f = fixture();
    const res = await request(f.app, '/auth/request', { email: UNKNOWN });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(f.emails.sent).toHaveLength(0);
  });

  it('a token is single-use and expires after 15 minutes', async () => {
    const f = fixture();
    await request(f.app, '/auth/request', { email: KNOWN });
    const token = tokenFrom(f.emails.sent[0]!.text);
    expect((await request(f.app, '/auth/verify', { token })).status).toBe(200);
    const again = await request(f.app, '/auth/verify', { token });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'invalid or expired login' });
    await request(f.app, '/auth/request', { email: KNOWN });
    const fresh = tokenFrom(f.emails.sent[1]!.text);
    f.advance(15 * 60 * 1000 + 1);
    expect((await request(f.app, '/auth/verify', { token: fresh })).status).toBe(401);
  });

  it('garbage tokens are rejected', async () => {
    const f = fixture();
    expect((await request(f.app, '/auth/verify', { token: 'nope' })).status).toBe(401);
  });
});
