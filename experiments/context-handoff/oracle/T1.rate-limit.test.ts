// Oracle for T1. Never given to the child; copied in at verification time.
// Asserts F2 (5/hour, keyed by email) and F8 (injected clock).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RateLimiter } from '../src/auth/rate-limit.js';

const HOUR = 60 * 60 * 1000;

describe('T1 rate limiter', () => {
  it('F2: allows exactly 5 per key per hour', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const got = [1, 2, 3, 4, 5, 6].map(() => rl.allow('a@example.com'));
    expect(got).toEqual([true, true, true, true, true, false]);
  });

  it('F2: the key is the caller-supplied string, and keys do not share an allowance', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 5; i++) rl.allow('a@example.com');
    expect(rl.allow('a@example.com')).toBe(false);
    expect(rl.allow('b@example.com')).toBe(true);
  });

  it('F2: the allowance recovers as the hour rolls forward', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 5; i++) rl.allow('a@example.com');
    expect(rl.allow('a@example.com')).toBe(false);
    t += HOUR + 1;
    expect(rl.allow('a@example.com')).toBe(true);
  });

  it('F8: uses the injected clock and never calls Date.now()', () => {
    const src = readFileSync(new URL('../src/auth/rate-limit.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Date\.now\s*\(/);

    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 5; i++) rl.allow('k');
    expect(rl.allow('k')).toBe(false);
    // Advancing only the injected clock must be enough to reset. If the module read the
    // real clock, this stays false.
    t += HOUR + 1;
    expect(rl.allow('k')).toBe(true);
  });
});
