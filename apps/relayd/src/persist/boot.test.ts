import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { readWorkspace } from './workspace.js';
import type { Workspace } from './workspace.js';

const ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE = path.join(ROOT, 'fixtures', 'events-live-6.jsonl');

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

/** A temp relayDir with `runs/<runId>/events.jsonl` (the fixture, optionally cut) + a hand-written workspace.json. */
function recordedRun(runId: string, cutBeforeType?: string) {
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const runDir = path.join(relayDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  let lines = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n');
  if (cutBeforeType) lines = lines.slice(0, lines.findIndex((l) => JSON.parse(l).type === cutBeforeType));
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines.join('\n') + '\n');
  const spawned = lines.map((l) => JSON.parse(l)).filter((e) => e.type === 'agent_spawned');
  const workspace: Workspace = {
    run_id: runId,
    repo: '/Users/allenchenhan99/entente-demo/app',
    missions: ['m-a1c415'],
    panes: spawned.map((e) => ({
      pane_id: e.payload.pane_id, task_id: e.task_id, role: e.task_id.replace(/^t-/, '').split('-')[0], runtime: e.payload.runtime,
      cwd: e.payload.cwd, session_id: e.payload.session_id, config_dir: path.join(relayDir, 'agents', e.task_id), alive: true, spawned_at: e.ts,
    })),
  };
  fs.writeFileSync(path.join(runDir, 'workspace.json'), JSON.stringify(workspace, null, 2));
  return { relayDir, runDir, events: lines.length };
}

async function boot(relayDir: string, extraEnv: Record<string, string> = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repo-'));
  const child = execa('npx', ['tsx', 'apps/relayd/src/index.ts'], {
    cwd: ROOT,
    env: { RELAY_HOST: 'fake', RELAY_PORT: '0', RELAY_REPO: repo, RELAY_DIR: relayDir, RELAY_RESUME: 'latest', ...extraEnv },
    reject: false, all: true, detached: true,
  });
  let output = '';
  const resumedLine = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no resumed line within 8 s; output so far:\n${output}`)), 8000);
    child.all!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const m = output.match(/relayd resumed run .*\n/);
      if (m) { clearTimeout(timer); resolve(m[0].trim()); }
    });
    void child.then(() => { clearTimeout(timer); reject(new Error(`relayd exited early:\n${output}`)); });
  });
  const url = output.match(/relayd listening on (http:\/\/127\.0\.0\.1:\d+)/)![1];
  return { child, resumedLine, url, output: () => output };
}

describe('boot resume', () => {
  it('RELAY_RESUME=latest reopens the recorded run (fixture, all tasks verified): 2 tasks, 0 panes respawned', async () => {
    const { relayDir, runDir, events } = recordedRun('run-live-6');
    const { child, resumedLine, url } = await boot(relayDir);
    try {
      expect(resumedLine).toBe('relayd resumed run run-live-6 (2 tasks, 0 panes respawned)');
      const state = await (await fetch(`${url}/state`)).json() as { tasks: Record<string, { task_state: string }> };
      expect(Object.entries(state.tasks).map(([id, t]) => [id, t.task_state])).toEqual([['t-backend-auth', 'completed'], ['t-frontend-login', 'completed']]);
      // Both recorded panes were marked exited (their tasks are terminal), appended after the fixture's last seq.
      const lines = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.slice(events).map((e) => [e.seq, e.type, e.payload.pane_id])).toEqual([[events + 1, 'agent_exited', 'relay:1'], [events + 2, 'agent_exited', 'relay:2']]);
      expect(readWorkspace(runDir)!.panes.map((p) => p.alive)).toEqual([false, false]);
    } finally {
      killGroup(child.pid);
      await child;
    }
  }, 20_000);

  it('a run cut while both agents were working respawns both panes through runtime.resume', async () => {
    const { relayDir, runDir, events } = recordedRun('run-mid', 'evidence_submitted');
    const { child, resumedLine, url } = await boot(relayDir);
    try {
      expect(resumedLine).toBe('relayd resumed run run-mid (2 tasks, 2 panes respawned)');
      const state = await (await fetch(`${url}/state`)).json() as { tasks: Record<string, { task_state: string; runtime: string; agent: { pane_id: string } }> };
      expect(Object.entries(state.tasks).map(([id, t]) => [id, t.task_state, t.runtime, t.agent.pane_id])).toEqual([
        ['t-backend-auth', 'executing', 'idle', '%fake-1'], ['t-frontend-login', 'executing', 'idle', '%fake-2'],
      ]);
      const lines = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.slice(events).map((e) => e.type)).toEqual(['agent_exited', 'agent_spawned', 'agent_exited', 'agent_spawned']);
      expect(lines.at(-1).payload.session_id).toBe('1b1dc427-d398-4bc5-9fe4-89dbe7e2a4cd');
      const ws = readWorkspace(runDir)!;
      expect(ws.panes.map((p) => [p.pane_id, p.task_id, p.alive])).toEqual([
        ['relay:1', 't-backend-auth', false], ['relay:2', 't-frontend-login', false], ['%fake-1', 't-backend-auth', true], ['%fake-2', 't-frontend-login', true],
      ]);
    } finally {
      killGroup(child.pid);
      await child;
    }
  }, 20_000);
});
