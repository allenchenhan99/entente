// Oracle for T4. Never given to the child; copied in at verification time.
// Asserts F4 (name `session`, HttpOnly, SameSite=Lax, Path=/, Max-Age=86400).
import { describe, expect, it } from 'vitest';
import { buildSessionCookie } from '../src/auth/session-cookie.js';

describe('T4 session cookie', () => {
  const header = buildSessionCookie('sid-123');

  it('F4: is named `session`, not `sid`', () => {
    expect(header.startsWith('session=sid-123')).toBe(true);
  });

  it('F4: is HttpOnly', () => {
    expect(header).toMatch(/;\s*HttpOnly/i);
  });

  it('F4: is SameSite=Lax, not Strict', () => {
    expect(header).toMatch(/;\s*SameSite=Lax/i);
    expect(header).not.toMatch(/SameSite=Strict/i);
  });

  it('F4: sets Path=/ and a 24 hour Max-Age', () => {
    expect(header).toMatch(/;\s*Path=\//i);
    expect(header).toMatch(/;\s*Max-Age=86400\b/i);
  });

  it('carries the id it was given', () => {
    expect(buildSessionCookie('another-id').startsWith('session=another-id')).toBe(true);
  });
});
