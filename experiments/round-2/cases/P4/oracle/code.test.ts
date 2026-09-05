import { describe, expect, it } from 'vitest';
import { KNOWN, UNKNOWN, cookieAttrs, cookieOf, fixture, request } from './_shared.js';

const codeFrom = (text: string): string => {
  const m = /\b(\d{6})\b/.exec(text);
  if (!m) throw new Error(`no 6-digit code in email: ${text}`);
  return m[1]!;
};

describe('P4 oracle — 6-digit code (the product owner chose the code)', () => {
  it('request → 202, email holds a 6-digit code; verify {email, code} → 200 + session cookie; /me works', async () => {
    const f = fixture();
    const res = await request(f.app, '/auth/request', { email: KNOWN });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(f.emails.sent).toHaveLength(1);
    expect(f.emails.sent[0]!.text).not.toMatch(/token=/);
    const code = codeFrom(f.emails.sent[0]!.text);
    const verified = await request(f.app, '/auth/verify', { email: KNOWN, code });
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

  it('a code is single-use, bound to the email, and expires after 15 minutes', async () => {
    const f = fixture();
    await request(f.app, '/auth/request', { email: KNOWN });
    const code = codeFrom(f.emails.sent[0]!.text);
    expect((await request(f.app, '/auth/verify', { email: 'grace@example.com', code })).status).toBe(401);
    expect((await request(f.app, '/auth/verify', { email: KNOWN, code })).status).toBe(200);
    const again = await request(f.app, '/auth/verify', { email: KNOWN, code });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: 'invalid or expired login' });
    await request(f.app, '/auth/request', { email: KNOWN });
    const fresh = codeFrom(f.emails.sent[1]!.text);
    f.advance(15 * 60 * 1000 + 1);
    expect((await request(f.app, '/auth/verify', { email: KNOWN, code: fresh })).status).toBe(401);
  });

  it('wrong codes are rejected', async () => {
    const f = fixture();
    await request(f.app, '/auth/request', { email: KNOWN });
    expect((await request(f.app, '/auth/verify', { email: KNOWN, code: '000000' })).status).toBe(401);
  });
});
