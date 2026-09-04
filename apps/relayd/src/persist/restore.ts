/**
 * Daemon restart: rebuild the orchestrator from the run's event log + workspace file and respawn every
 * agent that was alive in a fresh PTY that resumes its own session (PRD §5.3: state is derived from
 * events; §23: relayd hosts the panes, so a restart must bring them back).
 */

/** Runtime-agnostic prompt delivered to a resumed agent; it re-enters the protocol through relay_get_contract. */
export const RESUME_PROMPT =
  'relayd restarted. Your session was resumed. Call relay_get_contract, then continue exactly where you were: '
  + 'if you had submitted evidence, call relay_await_verdict; if you were waiting for clarification, call '
  + 'relay_await_contract; otherwise keep working.';

import fs from 'node:fs';
import path from 'node:path';
import type { EventStore } from '../ports.js';
import type { HostKind } from '../config.js';
import { loadConfig } from '../config.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { isPlannerTaskId } from '../orchestrator/orchestrator.js';
import { readWorkspace, panesFromEvents } from './workspace.js';
import type { WorkspacePane } from './workspace.js';

/** Newest run under `<relayDir>/runs` that has an `events.jsonl` (by that file's mtime, then name), if any. */
export function latestRunId(relayDir: string): string | undefined {
  const root = path.join(relayDir, 'runs');
  if (!fs.existsSync(root)) return undefined;
  const runs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, file: path.join(root, d.name, 'events.jsonl') }))
    .filter((r) => fs.existsSync(r.file))
    .map((r) => ({ id: r.id, mtime: fs.statSync(r.file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.id.localeCompare(a.id));
  return runs[0]?.id;
}

/**
 * `RELAY_RESUME=latest` (without `RELAY_RUN_ID`) selects the newest recorded run so `loadConfig` opens it.
 * Throws when nothing was recorded: the operator asked to resume, so silently starting a fresh run would hide
 * a mistake (wrong `RELAY_DIR`, for instance).
 */
export function resolveResumeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.RELAY_RESUME !== 'latest' || env.RELAY_RUN_ID) return env;
  const { relayDir } = loadConfig(env);
  const runId = latestRunId(relayDir);
  if (!runId) throw new Error(`RELAY_RESUME=latest: no recorded run under ${path.join(relayDir, 'runs')}`);
  return { ...env, RELAY_RUN_ID: runId };
}

/** First free `relay:<n>` number after the given pane ids (1 when none is a relay pane). */
export function nextRelayPaneNumber(paneIds: string[]): number {
  let max = 0;
  for (const id of paneIds) {
    const m = /^relay:(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** True when the run directory holds a log with at least one event, i.e. there is something to resume. */
export function hasRecordedEvents(runDir: string): boolean {
  const file = path.join(runDir, 'events.jsonl');
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}

export interface RestoreOptions {
  store: EventStore;
  orchestrator: Orchestrator;
  runDir: string;
  relayDir: string;
  /** Only `relay`, `relayterm` (and the test `fake`) host panes can be respawned; tmux/herdr panes are marked exited. */
  hostKind: HostKind;
  prompt?: string;
  log?: (message: string) => void;
}

export interface RestoreResult {
  missions: number;
  tasks: number;
  /** Alive panes found in the workspace (or derived from the log when the file is missing). */
  panes: number;
  respawned: string[];
  /** Alive panes deliberately not respawned (terminal task, finished mission, foreign host); marked exited. */
  skipped: string[];
  failed: Array<{ task_id: string; error: string }>;
  /** Evidence attempts interrupted by the previous daemon (no `evidence_recorded`), re-run through the check pipeline. */
  resumed_checks: Array<{ task_id: string; attempt: number }>;
}

const TERMINAL_TASK = new Set(['completed', 'canceled', 'failed']);
const TERMINAL_MISSION = new Set(['verified', 'failed']);

export async function restoreRun(opts: RestoreOptions): Promise<RestoreResult> {
  const log = opts.log ?? (() => {});
  const { store, orchestrator } = opts;
  const events = store.all();
  const { missions, tasks } = orchestrator.rehydrate(events);
  // Before the panes come back: an agent resumed into relay_await_verdict must find its verdict on the way.
  const resumedChecks = orchestrator.resumeChecks();
  for (const c of resumedChecks) log(`re-running interrupted checks for ${c.task_id} attempt ${c.attempt}`);

  const workspace = readWorkspace(opts.runDir);
  if (!workspace) log(`no workspace.json in ${opts.runDir}; pane inventory derived from the event log`);
  const alive = (workspace?.panes ?? panesFromEvents(events, opts.relayDir)).filter((p) => p.alive);
  const respawnable = opts.hostKind === 'relay' || opts.hostKind === 'relayterm' || opts.hostKind === 'fake';

  const result: RestoreResult = { missions, tasks, panes: alive.length, respawned: [], skipped: [], failed: [], resumed_checks: resumedChecks };
  const seen = new Set<string>();

  const missionOf = (pane: WorkspacePane): string | undefined =>
    isPlannerTaskId(pane.task_id) ? pane.task_id.slice('planner:'.length) : orchestrator.taskView(pane.task_id)?.mission_id;
  const markExited = (pane: WorkspacePane, reason: string) => {
    const missionId = missionOf(pane);
    if (!missionId) return;
    store.append({
      mission_id: missionId, task_id: isPlannerTaskId(pane.task_id) ? undefined : pane.task_id, actor: 'relayd',
      type: 'agent_exited', payload: { pane_id: pane.pane_id, exit_reason: reason },
    });
  };
  const resumable = (pane: WorkspacePane): boolean => {
    if (isPlannerTaskId(pane.task_id)) {
      const m = orchestrator.getMission(pane.task_id.slice('planner:'.length));
      return m !== undefined && !TERMINAL_MISSION.has(m.status);
    }
    const view = orchestrator.taskView(pane.task_id);
    return view !== undefined && !TERMINAL_TASK.has(view.task_state);
  };

  for (const pane of alive) {
    if (!respawnable) {
      markExited(pane, `daemon restart: ${opts.hostKind} panes are not resumed`);
      result.skipped.push(pane.task_id);
      continue;
    }
    if (seen.has(pane.task_id) || !resumable(pane)) {
      markExited(pane, 'daemon restart');
      if (!seen.has(pane.task_id)) result.skipped.push(pane.task_id);
      seen.add(pane.task_id);
      continue;
    }
    seen.add(pane.task_id);
    try {
      const { pane_id } = await orchestrator.respawn(pane.task_id, { prompt: opts.prompt ?? RESUME_PROMPT });
      result.respawned.push(pane.task_id);
      log(`respawned ${pane.task_id} (${pane.runtime} session ${pane.session_id}) in pane ${pane_id}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ task_id: pane.task_id, error });
      log(`resume of ${pane.task_id} failed: ${error}`);
    }
  }
  return result;
}
