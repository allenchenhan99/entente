import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePorts } from '../index.js';
import { loadConfig } from '../config.js';
import { createJsonlStore } from '../store/jsonl-store.js';

const store = () => createJsonlStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')) });

/** Mirrors the export shapes of the launch package on main: `create*(kind, deps)`. */
const launchModule = {
  createTerminalHost: (kind: string, deps: unknown) => ({ kind, deps, spawn: async () => ({ paneId: 'p' }), focus: async () => {}, isAlive: async () => true, kill: async () => {} }),
  createRuntime: (kind: string, deps: unknown) => ({ kind, deps, prepare: async () => ({ argv: [], env: {} }) }),
};
/** Mirrors wp/verify: `createCheckRunner({ store, worktrees, ... })`. */
const verifyModule = { createCheckRunner: (deps: { repoRoot: string; worktrees: unknown; store: unknown }) => ({ deps, run: async () => { throw new Error('unused'); } }) };
const worktreeModule = { createWorktreeManager: () => ({ real: true, create: async () => { throw new Error('unused'); }, remove: async () => {}, diff: async () => ({ patchPath: '', changedFiles: [] }), integrate: async () => ({ branch: 'relay/integration' }) }) };

describe('ports wiring', () => {
  it('uses real factories where their modules exist and fakes elsewhere', async () => {
    const importer = async (spec: string) =>
      spec.includes('launch') ? launchModule : spec.includes('verify') ? verifyModule : spec.includes('worktree') ? worktreeModule : undefined;
    const cfg = loadConfig({ RELAY_HOST: 'relayterm', RELAY_REPO: '/r' });
    const s = store();
    const ports = await resolvePorts(cfg, s, () => {}, importer);
    expect(ports.host.kind).toBe('relayterm');
    expect((ports.host as unknown as { deps: { relayDir?: string; runId?: string } }).deps).toMatchObject({ relayDir: expect.any(String), runId: expect.any(String) });
    expect(ports.runtimes['claude-code'].kind).toBe('claude-code');
    expect(ports.runtimes.codex.kind).toBe('codex');
    const checkDeps = (ports.checks as unknown as { deps: { repoRoot: string; worktrees: unknown; store: unknown } }).deps;
    expect(checkDeps.repoRoot).toBe('/r');
    expect(checkDeps.store).toBe(s);
    expect(checkDeps.worktrees).toBe(ports.worktrees);
    expect((ports.worktrees as unknown as { real: boolean }).real).toBe(true);
    expect(ports.fakes).toEqual(['repair']);
  });

  it('RELAY_HOST=fake forces the fake host and runtimes even when the launch module exists', async () => {
    const importer = async (spec: string) => (spec.includes('launch') ? launchModule : undefined);
    const ports = await resolvePorts(loadConfig({ RELAY_HOST: 'fake' }), store(), () => {}, importer);
    expect(ports.host.kind).toBe('relay');
    expect(ports.fakes).toEqual(['worktrees', 'checks', 'repair', 'host', 'runtime:claude-code', 'runtime:codex']);
  });

  it('a factory that throws falls back to the fake instead of crashing boot', async () => {
    const importer = async (spec: string) => (spec.includes('launch') ? { createTerminalHost: () => { throw new Error('no termd'); }, createRuntime: launchModule.createRuntime } : undefined);
    const logs: string[] = [];
    const ports = await resolvePorts(loadConfig({ RELAY_HOST: 'relayterm' }), store(), (m) => logs.push(m), importer);
    expect(ports.fakes).toContain('host');
    expect(ports.fakes).not.toContain('runtime:codex');
    expect(logs.join('\n')).toMatch(/no termd/);
  });
});
