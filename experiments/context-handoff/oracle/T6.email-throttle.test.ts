// Oracle for T6. Never given to the child; copied in at verification time.
// Asserts F7 (dedupe key is sha256 of the lowercased address) and F8 (injected clock).
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EmailThrottle } from '../src/auth/email-throttle.js';

const SECOND = 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('T6 email throttle', () => {
  it('suppresses a repeat inside 60 seconds and allows it after', () => {
    let t = 0;
    const th = new EmailThrottle(() => t);
    expect(th.shouldSend('a@example.com')).toBe(true);
    t = 59 * SECOND;
    expect(th.shouldSend('a@example.com')).toBe(false);
    t = 61 * SECOND;
    expect(th.shouldSend('a@example.com')).toBe(true);
  });

  it('F7: no key holds a plaintext address', () => {
    const th = new EmailThrottle(() => 0);
    th.shouldSend('a@example.com');
    for (const k of th.keys()) {
      expect(k).not.toContain('@');
      expect(k).not.toContain('example.com');
    }
  });

  it('F7: the key is sha256 of the lowercased address', () => {
    const th = new EmailThrottle(() => 0);
    th.shouldSend('A@Example.COM');
    expect(th.keys()).toEqual([sha256('a@example.com')]);
  });

  it('F7: case variants share one throttle entry', () => {
    let t = 0;
    const th = new EmailThrottle(() => t);
    expect(th.shouldSend('a@example.com')).toBe(true);
    t = 10 * SECOND;
    expect(th.shouldSend('A@EXAMPLE.COM')).toBe(false);
    expect(th.keys()).toHaveLength(1);
  });

  it('F8: uses the injected clock and never calls Date.now()', () => {
    const src = readFileSync(new URL('../src/auth/email-throttle.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Date\.now\s*\(/);
  });
});
