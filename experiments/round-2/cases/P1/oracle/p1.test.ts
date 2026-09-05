import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TTL_MS, TokenStore } from '../../src/auth/token-store.js';
import { EmailThrottle } from '../../src/auth/email-throttle.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('P1 oracle — token store follows the final decisions', () => {
  it('default TTL is the final 10 minutes, not 15 or 30', () => {
    expect(DEFAULT_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('valid at 9:59.999, expired at exactly 10:00', () => {
    let now = 1_000_000;
    const store = new TokenStore({ now: () => now });
    const t1 = store.create('ada@example.com');
    now += 10 * 60 * 1000 - 1;
    expect(store.consume(t1)).toBe('ada@example.com');
    const t2 = store.create('ada@example.com');
    now += 10 * 60 * 1000;
    expect(store.consume(t2)).toBeUndefined();
  });

  it('single use, and only the sha256 hash is at rest', () => {
    const store = new TokenStore({ now: () => 5 });
    const raw = store.create('grace@example.com');
    expect(raw.length).toBeGreaterThanOrEqual(32);
    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hash).toBe(sha256(raw));
    expect(JSON.stringify(entries)).not.toContain(raw);
    expect(store.consume(raw)).toBe('grace@example.com');
    expect(store.consume(raw)).toBeUndefined();
    expect(store.consume('not-a-token')).toBeUndefined();
  });
});

describe('P1 oracle — throttle keys are sha256(lowercase(trim(email)))', () => {
  it('keys are hashed, case/whitespace-insensitive, never plaintext', () => {
    let now = 0;
    const throttle = new EmailThrottle({ now: () => now });
    expect(throttle.shouldSend('  Ada@Example.com ')).toBe(true);
    expect(throttle.shouldSend('ada@example.com')).toBe(false);
    expect(throttle.keys()).toEqual([sha256('ada@example.com')]);
    expect(JSON.stringify(throttle.keys())).not.toMatch(/example\.com/);
    now += 59_999;
    expect(throttle.shouldSend('ada@example.com')).toBe(false);
    now += 1;
    expect(throttle.shouldSend('ada@example.com')).toBe(true);
  });
});
