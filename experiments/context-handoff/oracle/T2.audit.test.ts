// Oracle for T2. Never given to the child; copied in at verification time.
// Asserts F5 (never log a token or its hash) and F6 (UTC ISO-8601 with trailing Z).
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/auth/audit.js';

describe('T2 audit log', () => {
  it('F6: `at` is UTC ISO-8601 ending in Z', () => {
    const log = new AuditLog(() => Date.parse('2026-03-04T05:06:07.008Z'));
    log.record('link_requested', { tokenId: 'tid-1' });
    expect(log.entries()[0].at).toBe('2026-03-04T05:06:07.008Z');
  });

  it('F6: the timestamp comes from the injected clock, not the wall clock', () => {
    let t = Date.parse('2020-01-01T00:00:00.000Z');
    const log = new AuditLog(() => t);
    log.record('a', {});
    t += 86_400_000;
    log.record('b', {});
    expect(log.entries().map((e) => e.at)).toEqual([
      '2020-01-01T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z',
    ]);
  });

  it('F5: drops a token value handed to it', () => {
    const log = new AuditLog(() => 0);
    log.record('link_requested', { tokenId: 'tid-1', token: 'SECRET-TOKEN-VALUE' });
    const blob = JSON.stringify(log.entries());
    expect(blob).not.toContain('SECRET-TOKEN-VALUE');
    expect(blob).toContain('tid-1');
  });

  it('F5: drops a token hash too, not just the raw token', () => {
    const hash = 'a'.repeat(64);
    const log = new AuditLog(() => 0);
    log.record('link_verified', { tokenId: 'tid-2', tokenHash: hash });
    const blob = JSON.stringify(log.entries());
    expect(blob).not.toContain(hash);
    expect(blob).toContain('tid-2');
  });

  it('keeps unrelated fields', () => {
    const log = new AuditLog(() => 0);
    log.record('link_requested', { tokenId: 'tid-3', ip: '10.0.0.1' });
    expect(log.entries()[0].fields).toMatchObject({ tokenId: 'tid-3', ip: '10.0.0.1' });
  });
});
