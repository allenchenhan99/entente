import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';

describe('config', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(7420);
    expect(c.repoRoot).toBe(process.cwd());
    expect(c.relayDir).toBe(`${process.cwd()}/.relay`);
    expect(c.host).toBe('tmux');
    expect(c.runId).toMatch(/^run-/);
  });
  it('reads env overrides', () => {
    const c = loadConfig({ RELAY_PORT: '0', RELAY_REPO: '/r', RELAY_DIR: '/d', RELAY_HOST: 'fake', RELAY_RUN_ID: 'r1' });
    expect(c).toMatchObject({ port: 0, repoRoot: '/r', relayDir: '/d', host: 'fake', runId: 'r1' });
  });
  it('rejects an unknown host', () => {
    expect(() => loadConfig({ RELAY_HOST: 'screen' })).toThrow(/RELAY_HOST/);
  });
  it('reads the session token mode from RELAY_AUTH (default optional)', () => {
    expect(loadConfig({}).authMode).toBe('optional');
    expect(loadConfig({ RELAY_AUTH: 'required' }).authMode).toBe('required');
    expect(() => loadConfig({ RELAY_AUTH: 'off' })).toThrow(/RELAY_AUTH/);
  });
});
