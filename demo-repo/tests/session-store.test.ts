import { describe, expect, it } from 'vitest';

import { SessionStore } from '../src/session/store.js';

describe('SessionStore', () => {
  it('creates and returns a live session', () => {
    const store = new SessionStore(() => 1_000);

    const session = store.create('user-1', 500);

    expect(session).toEqual({
      id: expect.any(String),
      userId: 'user-1',
      expiresAt: 1_500,
    });
    expect(store.get(session.id)).toEqual(session);
  });

  it('keeps a session at its exact expiry boundary', () => {
    let currentTime = 1_000;
    const store = new SessionStore(() => currentTime);
    const session = store.create('user-1', 500);

    currentTime = 1_500;

    expect(store.get(session.id)).toEqual(session);
  });

  it('hides and removes a session after it expires', () => {
    let currentTime = 1_000;
    const store = new SessionStore(() => currentTime);
    const session = store.create('user-1', 500);

    currentTime = 1_501;

    expect(store.get(session.id)).toBeUndefined();
    currentTime = 1_000;
    expect(store.get(session.id)).toBeUndefined();
  });

  it('revokes an existing session', () => {
    const store = new SessionStore(() => 1_000);
    const session = store.create('user-1', 500);

    expect(store.revoke(session.id)).toBe(true);
    expect(store.get(session.id)).toBeUndefined();
    expect(store.revoke(session.id)).toBe(false);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY])('rejects an invalid lifetime of %s', (ttlMs) => {
    const store = new SessionStore(() => 1_000);

    expect(() => store.create('user-1', ttlMs)).toThrow('ttlMs must be a finite positive number');
  });
});
