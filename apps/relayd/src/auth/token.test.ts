import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import {
  bearerToken,
  createSessionAuth,
  generateSessionToken,
  isGuardedPath,
  parseAuthMode,
  sessionGuard,
  upgradeToken,
  verifySessionToken,
} from './token.js';

const tempDirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('session token', () => {
  it('generates 32 hex characters, fresh each time', () => {
    const a = generateSessionToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSessionToken()).not.toBe(a);
  });

  it('writes <relayDir>/session.token with mode 0600 and exposes the token', () => {
    const relayDir = tempDir();
    const auth = createSessionAuth({ relayDir, mode: 'optional' });
    expect(auth.token).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.file).toBe(path.join(relayDir, 'session.token'));
    expect(fs.readFileSync(auth.file, 'utf8')).toBe(auth.token);
    expect(fs.statSync(auth.file).mode & 0o777).toBe(0o600);
    // A stale world-readable file from an older run is replaced and tightened.
    fs.chmodSync(auth.file, 0o644);
    const again = createSessionAuth({ relayDir, mode: 'optional' });
    expect(again.token).not.toBe(auth.token);
    expect(fs.statSync(again.file).mode & 0o777).toBe(0o600);
  });

  it('parses RELAY_AUTH (default optional) and rejects unknown modes', () => {
    expect(parseAuthMode(undefined)).toBe('optional');
    expect(parseAuthMode('optional')).toBe('optional');
    expect(parseAuthMode('required')).toBe('required');
    expect(() => parseAuthMode('off')).toThrow(/RELAY_AUTH/);
  });

  it('always guards pane, pty and runs routes; guards the rest only when required; never health or mcp', () => {
    for (const p of ['/panes', '/panes/relay:1/screen', '/pty/relay:1', '/runs', '/runs/run-1/casts']) {
      expect(isGuardedPath(p, 'optional'), p).toBe(true);
      expect(isGuardedPath(p, 'required'), p).toBe(true);
    }
    for (const p of ['/state', '/events', '/events/log', '/missions', '/missions/m-1/plan', '/tasks/t-1/review']) {
      expect(isGuardedPath(p, 'optional'), p).toBe(false);
      expect(isGuardedPath(p, 'required'), p).toBe(true);
    }
    for (const p of ['/health', '/mcp', '/panesx', '/runsabc']) {
      expect(isGuardedPath(p, 'required'), p).toBe(false);
    }
  });

  it('extracts the bearer token from HTTP and the relay.<token> subprotocol from a WS upgrade', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    expect(upgradeToken({ headers: { 'sec-websocket-protocol': 'relay.abc' } })).toBe('abc');
    expect(upgradeToken({ headers: { 'sec-websocket-protocol': 'other, relay.abc' } })).toBe('abc');
    expect(upgradeToken({ headers: {} })).toBeUndefined();
  });

  it('verifies with a constant-time comparison and rejects near misses', () => {
    const auth = createSessionAuth({ relayDir: tempDir(), mode: 'optional' });
    expect(verifySessionToken(auth, auth.token)).toBe(true);
    expect(verifySessionToken(auth, auth.token.slice(0, -1) + 'x')).toBe(false);
    expect(verifySessionToken(auth, auth.token + '0')).toBe(false);
    expect(verifySessionToken(auth, '')).toBe(false);
    expect(verifySessionToken(auth, undefined)).toBe(false);
  });

  it('as Hono middleware answers 401 {error} for missing or wrong tokens on guarded paths only', async () => {
    const auth = createSessionAuth({ relayDir: tempDir(), mode: 'optional' });
    const app = new Hono();
    app.use('*', sessionGuard(auth));
    app.get('/panes', (c) => c.json({ panes: [] }));
    app.get('/state', (c) => c.json({ ok: true }));
    const missing = await app.request('/panes');
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'missing session token: send Authorization: Bearer <relayd token>' });
    const wrong = await app.request('/panes', { headers: { authorization: 'Bearer ' + 'f'.repeat(32) } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'invalid session token' });
    const ok = await app.request('/panes', { headers: { authorization: `Bearer ${auth.token}` } });
    expect(ok.status).toBe(200);
    expect((await app.request('/state')).status).toBe(200);
  });
});
