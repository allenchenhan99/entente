/**
 * Adopting a session the human started by hand — the rule that a session a person opens is a brain
 * and a session an agent opens is a sub, applied where sessions are made.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrchestrator } from './orchestrator.js';
import { createJsonlStore } from '../store/jsonl-store.js';
import type { AgentRuntime, TerminalHost, WorktreeManager, CheckRunner, RepairPolicy } from '../ports.js';
import type { RuntimeKind } from '@relay/protocol';

function runtime(kind: RuntimeKind, calls: string[]): AgentRuntime {
  return {
    kind,
    async prepare() {
      calls.push('prepare');
      return { argv: [kind, '--dangerously-skip-permissions'], env: {}, prompt: 'bootstrap' };
    },
    async adopt(spec, configDir, instructions) {
      calls.push('adopt');
      return { argv: ['--mcp-config', path.join(configDir, 'mcp.json'), '--system', instructions], env: { RELAY_TOKEN: spec.token } };
    },
  };
}

function make(kinds: { calls: string[]; annotations?: { set: (id: string, a: unknown) => void } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-adopt-'));
  const store = createJsonlStore({ dir });
  const host = { kind: 'relay', spawn: async () => ({ paneId: 'relay:9' }), focus: async () => {}, isAlive: async () => true, kill: async () => {} } as unknown as TerminalHost;
  const orchestrator = createOrchestrator({
    store,
    host,
    worktrees: {} as WorktreeManager,
    checks: {} as CheckRunner,
    repair: {} as RepairPolicy,
    runtimes: { 'claude-code': runtime('claude-code', kinds.calls), codex: runtime('codex', kinds.calls) },
    repoRoot: dir,
    relayDir: dir,
    mcpUrl: 'http://127.0.0.1:7420/mcp',
    brainInstructions: (id) => `brain of ${id}`,
    annotations: kinds.annotations,
  });
  return { orchestrator, store, dir };
}

describe('adopting a hand-started session', () => {
  it('gives it a mission and a planner token without anyone declaring it is the planner', async () => {
    const calls: string[] = [];
    const { orchestrator, store } = make({ calls });

    const session = await orchestrator.adoptSession({ runtime: 'claude-code', pane_id: 'relay:3', cwd: '/repo' });

    expect(session.mission_id).toMatch(/^m-/);
    expect(session.instructions).toBe(`brain of ${session.mission_id}`);
    // The wiring the agent needs, and nothing that would spawn a second process.
    expect(session.argv).toContain('--mcp-config');
    expect(session.env.RELAY_TOKEN).toBeTruthy();

    // `human`, because a person started it. That actor is the whole basis for calling it a brain.
    const spawned = store.all().filter((e) => e.type === 'agent_spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].actor).toBe('human');
    expect(spawned[0].payload).toMatchObject({ runtime: 'claude-code', pane_id: 'relay:3', cwd: '/repo' });
  });

  it('adopts rather than prepares, so the human keeps their own permission model', async () => {
    const calls: string[] = [];
    const { orchestrator } = make({ calls });

    const session = await orchestrator.adoptSession({ runtime: 'claude-code', pane_id: 'relay:3', cwd: '/repo' });

    // `prepare` equips an unattended agent: permission prompts off, tool list pinned. Reusing it here
    // would strip the dialogs from a session someone is sitting in front of.
    expect(calls).toEqual(['adopt']);
    expect(session.argv).not.toContain('--dangerously-skip-permissions');
  });

  it('tells the pane listing what the shell became, so the agent reaches the graph', async () => {
    const calls: string[] = [];
    const annotated: Array<[string, unknown]> = [];
    const { orchestrator } = make({ calls, annotations: { set: (id, a) => annotated.push([id, a]) } });

    await orchestrator.adoptSession({ runtime: 'codex', pane_id: 'relay:7', cwd: '/repo' });

    // The host still sees the shell it spawned; the graph draws an agent for any pane with a runtime.
    expect(annotated).toEqual([['relay:7', { role: 'brain', runtime: 'codex' }]]);
  });

  it('gives each session its own mission rather than crowding one', async () => {
    const calls: string[] = [];
    const { orchestrator } = make({ calls });

    const first = await orchestrator.adoptSession({ runtime: 'claude-code', pane_id: 'relay:1', cwd: '/repo' });
    const second = await orchestrator.adoptSession({ runtime: 'claude-code', pane_id: 'relay:2', cwd: '/repo' });

    // A mission has one planner token and one planner pane; a second brain on it would take the
    // first one's place without saying so.
    expect(first.mission_id).not.toBe(second.mission_id);
    expect(first.session_id).not.toBe(second.session_id);
  });
});
