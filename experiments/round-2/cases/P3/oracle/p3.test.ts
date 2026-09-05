import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EmailThrottle } from '../../src/auth/email-throttle.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('P3 oracle — email throttle', () => {
  it('hashes keys, folds case and whitespace, and never stores plaintext', () => {
    let now = 0;
    const t = new EmailThrottle({ now: () => now });
    expect(t.shouldSend('  Ada@Example.com ')).toBe(true);
    expect(t.shouldSend('ada@example.com')).toBe(false);
    expect(t.keys()).toEqual([sha256('ada@example.com')]);
    expect(JSON.stringify(t.keys())).not.toMatch(/example\.com/);
  });

  it('allows again at exactly the window and treats a backwards clock as no time passed', () => {
    let now = 10_000;
    const t = new EmailThrottle({ now: () => now });
    expect(t.shouldSend('ada@example.com')).toBe(true);
    now += 59_999;
    expect(t.shouldSend('ada@example.com')).toBe(false);
    now += 1;
    expect(t.shouldSend('ada@example.com')).toBe(true);
    now -= 30_000;
    expect(t.shouldSend('ada@example.com')).toBe(false);
  });

  it('independent addresses do not throttle each other', () => {
    const t = new EmailThrottle({ now: () => 0 });
    expect(t.shouldSend('ada@example.com')).toBe(true);
    expect(t.shouldSend('grace@example.com')).toBe(true);
  });
});
