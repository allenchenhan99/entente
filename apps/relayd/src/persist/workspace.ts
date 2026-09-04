/**
 * Workspace file: `<relayDir>/runs/<run-id>/workspace.json`, the pane inventory relayd needs to respawn
 * agents after a restart (session ids, config dirs, cwd). It is derived from `agent_spawned` /
 * `agent_exited` events and rewritten atomically (tmp + rename) on every such event and periodically
 * while panes are alive, so that a crash never leaves a half-written file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Event, RuntimeKind, State } from '@relay/protocol';
import { replay } from '@relay/protocol';
import type { EventStore, TerminalHost } from '../ports.js';
import { agentConfigDir, plannerTaskId } from '../orchestrator/orchestrator.js';

export interface WorkspacePane {
  pane_id: string;
  /** Task id, or `planner:<mission-id>` for a planner pane. */
  task_id: string;
  /** Agent role (contract recipient, or `planner`). */
  role: string;
  runtime: RuntimeKind;
  cwd: string;
  session_id: string;
  config_dir: string;
  alive: boolean;
  spawned_at: string;
}

export interface Workspace {
  run_id: string;
  repo: string;
  missions: string[];
  panes: WorkspacePane[];
}

export const WORKSPACE_FILE = 'workspace.json';
export const WORKSPACE_INTERVAL_MS = 30_000;

export const workspacePath = (runDir: string): string => path.join(runDir, WORKSPACE_FILE);

export function readWorkspace(runDir: string): Workspace | undefined {
  const file = workspacePath(runDir);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Workspace;
}

/** Atomic write: the content lands in a sibling temp file first, then `rename` replaces the target. */
export function writeWorkspace(runDir: string, workspace: Workspace): void {
  fs.mkdirSync(runDir, { recursive: true });
  const file = workspacePath(runDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(workspace, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const isPlannerPane = (ev: Event): boolean => ev.task_id === undefined;

/** Rebuilds the pane inventory from the event log (`alive` = spawned without a later `agent_exited`). */
export function panesFromEvents(events: Event[], relayDir: string): WorkspacePane[] {
  const panes: WorkspacePane[] = [];
  let state: State = replay([]);
  for (const ev of events) {
    state = replay([ev], state);
    if (ev.type === 'agent_spawned') {
      const taskId = isPlannerPane(ev) ? plannerTaskId(ev.mission_id) : ev.task_id!;
      const role = isPlannerPane(ev) ? 'planner' : state.tasks[ev.task_id!]?.contract.recipient ?? ev.task_id!;
      panes.push({
        pane_id: ev.payload.pane_id, task_id: taskId, role, runtime: ev.payload.runtime, cwd: ev.payload.cwd,
        session_id: ev.payload.session_id, config_dir: agentConfigDir(relayDir, taskId), alive: true, spawned_at: ev.ts,
      });
    } else if (ev.type === 'agent_exited') {
      for (const p of panes) if (p.pane_id === ev.payload.pane_id) p.alive = false;
    }
  }
  return panes;
}

export type Schedule = (fn: () => void, intervalMs: number) => () => void;

export interface WorkspaceTrackerOptions {
  store: EventStore;
  runDir: string;
  runId: string;
  repo: string;
  relayDir: string;
  /** When given, the periodic write refreshes `alive` from the host (a pane can die without an event). */
  host?: Pick<TerminalHost, 'isAlive'>;
  /** Periodic timer; defaults to `setInterval`. Tests inject a manual one. */
  schedule?: Schedule;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface WorkspaceTracker {
  snapshot(): Workspace;
  /** Rewrites the file now (refreshing `alive` from the host when available). */
  flush(): Promise<void>;
  stop(): void;
}

const defaultSchedule: Schedule = (fn, ms) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

export function createWorkspaceTracker(opts: WorkspaceTrackerOptions): WorkspaceTracker {
  const log = opts.log ?? (() => {});
  const schedule = opts.schedule ?? defaultSchedule;
  const intervalMs = opts.intervalMs ?? WORKSPACE_INTERVAL_MS;
  const existing = readWorkspace(opts.runDir);
  const missions = new Set<string>(Object.keys(opts.store.state().missions));
  const panes: WorkspacePane[] = existing?.panes.map((p) => ({ ...p })) ?? panesFromEvents(opts.store.all(), opts.relayDir);

  const snapshot = (): Workspace => ({ run_id: opts.runId, repo: opts.repo, missions: [...missions], panes: panes.map((p) => ({ ...p })) });
  const write = () => {
    try {
      writeWorkspace(opts.runDir, snapshot());
    } catch (err) {
      log(`workspace write failed: ${(err as Error).message ?? err}`);
    }
  };

  let cancel: (() => void) | undefined;
  const anyAlive = () => panes.some((p) => p.alive);
  const refreshAlive = async () => {
    if (!opts.host) return;
    for (const p of panes) if (p.alive) p.alive = await opts.host.isAlive(p.pane_id);
  };
  const tick = () => {
    void refreshAlive().then(() => {
      write();
      if (!anyAlive()) stopTimer();
    });
  };
  const stopTimer = () => {
    cancel?.();
    cancel = undefined;
  };
  const ensureTimer = () => {
    if (cancel || !anyAlive()) return;
    cancel = schedule(tick, intervalMs);
  };

  const unsubscribe = opts.store.subscribe((ev, state) => {
    if (ev.type === 'mission_created') {
      missions.add(ev.payload.id);
      return;
    }
    if (ev.type === 'agent_spawned') {
      const taskId = isPlannerPane(ev) ? plannerTaskId(ev.mission_id) : ev.task_id!;
      const role = isPlannerPane(ev) ? 'planner' : state.tasks[ev.task_id!]?.contract.recipient ?? ev.task_id!;
      panes.push({
        pane_id: ev.payload.pane_id, task_id: taskId, role, runtime: ev.payload.runtime, cwd: ev.payload.cwd,
        session_id: ev.payload.session_id, config_dir: agentConfigDir(opts.relayDir, taskId), alive: true, spawned_at: ev.ts,
      });
      write();
      ensureTimer();
    } else if (ev.type === 'agent_exited') {
      for (const p of panes) if (p.pane_id === ev.payload.pane_id) p.alive = false;
      write();
      if (!anyAlive()) stopTimer();
    }
  });

  write();
  ensureTimer();

  return {
    snapshot,
    async flush() {
      await refreshAlive();
      write();
    },
    stop() {
      unsubscribe();
      stopTimer();
    },
  };
}
