// Oracle for T3. Never given to the child; copied in at verification time.
// Asserts F1 (15 minutes, single-use) and F8 (injected clock).
// This is the superseded-fact case: a handoff carrying F1-old (30 minutes) fails here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TokenStore } from '../src/auth/token-store.js';

const MIN = 60 * 1000;

describe('T3 token store', () => {
  it('F1: a fresh token resolves to the email', () => {
    const store = new TokenStore(() => 0);
    const token = store.create('a@example.com');
    expect(store.consume(token)).toBe('a@example.com');
  });

  it('F1: expires at 15 minutes, not 30', () => {
    let t = 0;
    const store = new TokenStore(() => t);
    const token = store.create('a@example.com');

    t = 14 * MIN;
    expect(store.consume(token)).toBe('a@example.com');

    // A store built on the superseded 30-minute decision still resolves here.
    let t2 = 0;
    const store2 = new TokenStore(() => t2);
    const token2 = store2.create('b@example.com');
    t2 = 16 * MIN;
    expect(store2.consume(token2)).toBeNull();
  });

  it('F1: single-use — a second consume fails inside the window', () => {
    let t = 0;
    const store = new TokenStore(() => t);
    const token = store.create('a@example.com');
    expect(store.consume(token)).toBe('a@example.com');
    t = 1 * MIN;
    expect(store.consume(token)).toBeNull();
  });

  it('F1: an unknown token is null, not a throw', () => {
    const store = new TokenStore(() => 0);
    expect(store.consume('not-a-real-token')).toBeNull();
  });

  it('F8: uses the injected clock and never calls Date.now()', () => {
    const src = readFileSync(new URL('../src/auth/token-store.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Date\.now\s*\(/);
  });

  it('tokens are opaque and distinct per issue', () => {
    const store = new TokenStore(() => 0);
    const a = store.create('a@example.com');
    const b = store.create('a@example.com');
    expect(a).not.toBe(b);
    expect(a).not.toContain('a@example.com');
  });
});
