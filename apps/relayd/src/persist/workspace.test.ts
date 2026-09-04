import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRelay, sampleContract } from '../fakes/test-harness.js';
import { createWorkspaceTracker, readWorkspace, writeWorkspace, workspacePath, panesFromEvents } from './workspace.js';
import type { Workspace } from './workspace.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));

/** A manual scheduler: `fire()` runs every pending tick once. */
function manualSchedule() {
  const ticks = new Map<number, () => void>();
  let n = 0;
  const schedule = (fn: () => void, _ms: number) => {
    const id = ++n;
    ticks.set(id, fn);
    return () => { ticks.delete(id); };
  };
  return { schedule, fire: () => { for (const fn of [...ticks.values()]) fn(); }, get active() { return ticks.size; } };
}

describe('workspace file', () => {
  it('writeWorkspace writes atomically (tmp + rename) and readWorkspace round-trips it', () => {
    const dir = tmp();
    const ws: Workspace = {
      run_id: 'run-1', repo: '/repo', missions: ['m-1'],
      panes: [{ pane_id: 'relay:1', task_id: 't-a', role: 'a', runtime: 'claude-code', cwd: '/wt/t-a', session_id: 's-1', config_dir: '/cfg/t-a', alive: true, spawned_at: '2026-09-04T00:00:00.000Z' }],
    };
    writeWorkspace(dir, ws);
    expect(fs.existsSync(workspacePath(dir))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(readWorkspace(dir)).toEqual(ws);
    expect(readWorkspace(tmp())).toBeUndefined();
  });

  it('workspace is written on agent_spawned and agent_exited with the documented shape', async () => {
    const r = createTestRelay({ clock: () => '2026-09-04T00:00:00.000Z' });
    const runDir = path.join(r.dir, 'run');
    const timer = manualSchedule();
    const tracker = createWorkspaceTracker({ store: r.store, runDir, runId: 'run-x', repo: '/repo', relayDir: path.join(r.dir, '.relay'), host: r.host, schedule: timer.schedule });
    expect(readWorkspace(runDir)).toEqual({ run_id: 'run-x', repo: '/repo', missions: [], panes: [] });

    const { mission_id } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    await r.orchestrator.spawnPlanner(mission_id, 'claude-code');
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-a', { runtime: 'codex' }), 'planner');
    await r.orchestrator.settled();

    const ws = readWorkspace(runDir)!;
    expect(ws.run_id).toBe('run-x');
    expect(ws.repo).toBe('/repo');
    expect(ws.missions).toEqual([mission_id]);
    expect(ws.panes).toHaveLength(2);
    const [planner, task] = ws.panes;
    expect(planner).toEqual({
      pane_id: '%fake-1', task_id: `planner:${mission_id}`, role: 'planner', runtime: 'claude-code', cwd: r.dir,
      session_id: expect.stringMatching(/^[0-9a-f-]{36}$/), config_dir: path.join(r.dir, '.relay', 'agents', `planner-${mission_id}`),
      alive: true, spawned_at: '2026-09-04T00:00:00.000Z',
    });
    expect(task).toEqual({
      pane_id: '%fake-2', task_id: 't-a', role: 'a', runtime: 'codex', cwd: '/tmp/fake/t-a',
      session_id: r.orchestrator.taskView('t-a')!.agent!.session_id, config_dir: path.join(r.dir, '.relay', 'agents', 't-a'),
      alive: true, spawned_at: '2026-09-04T00:00:00.000Z',
    });

    r.store.append({ mission_id, task_id: 't-a', actor: 'relayd', type: 'agent_exited', payload: { pane_id: '%fake-2', exit_reason: 'test' } });
    expect(readWorkspace(runDir)!.panes.map((p) => [p.pane_id, p.alive])).toEqual([['%fake-1', true], ['%fake-2', false]]);
    tracker.stop();
  });

  it('workspace periodic write is observable with an injected timer while panes are alive', async () => {
    const r = createTestRelay();
    const runDir = path.join(r.dir, 'run');
    const timer = manualSchedule();
    const tracker = createWorkspaceTracker({ store: r.store, runDir, runId: 'run-x', repo: '/repo', relayDir: path.join(r.dir, '.relay'), host: r.host, schedule: timer.schedule, intervalMs: 30_000 });
    expect(timer.active).toBe(0);

    const { mission_id } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    await r.orchestrator.spawnPlanner(mission_id, 'claude-code');
    expect(timer.active).toBe(1);

    // The pane dies without an event (process crash): the tick refreshes `alive` from the host.
    r.host.alive.clear();
    const before = fs.statSync(workspacePath(runDir)).mtimeMs;
    fs.utimesSync(workspacePath(runDir), new Date(before - 5000), new Date(before - 5000));
    timer.fire();
    await new Promise<void>((resolve) => setImmediate(resolve)); // the tick awaits host.isAlive
    expect(fs.statSync(workspacePath(runDir)).mtimeMs).toBeGreaterThan(before - 5000);
    expect(readWorkspace(runDir)!.panes[0].alive).toBe(false);
    // Nothing alive any more: the timer stops until the next spawn.
    expect(timer.active).toBe(0);
    tracker.stop();
  });

  it('workspace tracker starts from the existing file when present, else from the events', () => {
    const r = createTestRelay();
    const runDir = path.join(r.dir, 'run');
    r.store.append({ mission_id: 'm-1', actor: 'human', type: 'mission_created', payload: { id: 'm-1', repo: '/repo', title: 't', success_definition: '', integration_check: 'true', budget: { max_repairs_per_task: 3 } } });
    r.store.append({ mission_id: 'm-1', actor: 'relayd', type: 'agent_spawned', payload: { runtime: 'claude-code', pane_id: 'relay:1', session_id: 's-p', cwd: '/repo' } });
    r.store.append({ mission_id: 'm-1', task_id: 't-a', actor: 'relayd', type: 'agent_spawned', payload: { runtime: 'codex', pane_id: 'relay:2', session_id: 's-a', cwd: '/wt' } });
    r.store.append({ mission_id: 'm-1', task_id: 't-a', actor: 'relayd', type: 'agent_exited', payload: { pane_id: 'relay:2' } });

    const fromEvents = panesFromEvents(r.store.all(), path.join(r.dir, '.relay'));
    expect(fromEvents.map((p) => [p.pane_id, p.task_id, p.role, p.alive])).toEqual([['relay:1', 'planner:m-1', 'planner', true], ['relay:2', 't-a', 't-a', false]]);

    const tracker = createWorkspaceTracker({ store: r.store, runDir, runId: 'run-x', repo: '/repo', relayDir: path.join(r.dir, '.relay'), schedule: manualSchedule().schedule });
    expect(readWorkspace(runDir)!.panes).toEqual(fromEvents);
    expect(readWorkspace(runDir)!.missions).toEqual(['m-1']);
    tracker.stop();

    const edited: Workspace = { ...readWorkspace(runDir)!, panes: [{ ...fromEvents[0], alive: false }] };
    writeWorkspace(runDir, edited);
    const tracker2 = createWorkspaceTracker({ store: r.store, runDir, runId: 'run-x', repo: '/repo', relayDir: path.join(r.dir, '.relay'), schedule: manualSchedule().schedule });
    expect(tracker2.snapshot().panes).toEqual(edited.panes);
    tracker2.stop();
  });
});
