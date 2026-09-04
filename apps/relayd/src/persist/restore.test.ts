import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskView } from '@relay/protocol';
import { createTestRelay, sampleContract } from '../fakes/test-harness.js';
import type { TestRelay } from '../fakes/test-harness.js';
import { createWorkspaceTracker, readWorkspace, writeWorkspace } from './workspace.js';
import { restoreRun, RESUME_PROMPT, latestRunId, resolveResumeEnv } from './restore.js';

const mission = { repo: '/repo', title: 'Add login' };
const accept = (v: number) => ({ contract_version: v, decision: 'accepted' as const, interpretation: ['x'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'run' }, questions: [] });
const needs = { contract_version: 1, decision: 'needs_clarification' as const, interpretation: [], assumptions: [], risks: [], verification_plan: {}, questions: [{ id: 'Q1', text: 'Which mechanism?', blocking: true }] };
const claimedAll = { 'AC-1': { status: 'passed' as const }, 'AC-2': { status: 'passed' as const }, 'AC-3': { status: 'passed' as const } };
const humanAc = { id: 'AC-3', condition: 'looks right to a human', check: { kind: 'human_review' as const } };
const script = { 'AC-3': 'pending_human' as const };
const noSchedule = () => () => {};

/** Timestamps are the one thing the reducer (event ts) and the orchestrator (clock at mutation) legitimately differ on. */
const stable = (v: TaskView) => {
  const { proposed_at, accepted_at, started_at, last_seen_at, completed_at, blocker, ...rest } = v;
  return { ...rest, blocker: blocker && { reason: blocker.reason, waiting_on: blocker.waiting_on } };
};

/**
 * Run 1: planner spawned; t-a clarified to v2, accepted, blocked + replied, evidence attempt 1 submitted with AC-3
 * pending human; t-b completed; t-c (codex) accepted and working. Returns the run and its workspace dir.
 */
async function firstRun(dir: string) {
  const r = createTestRelay({ dir, script });
  const runDir = path.join(dir, 'run');
  const tracker = createWorkspaceTracker({ store: r.store, runDir, runId: 'run-1', repo: '/repo', relayDir: path.join(dir, '.relay'), host: r.host, schedule: noSchedule });
  const { mission_id } = r.orchestrator.createMission(mission);
  await r.orchestrator.spawnPlanner(mission_id, 'claude-code');
  const contract = sampleContract('t-a');
  await r.orchestrator.proposeTask(mission_id, { ...contract, acceptance_criteria: [...contract.acceptance_criteria, humanAc] }, 'planner');
  expect(r.orchestrator.respond('t-a', needs).status).toBe('waiting');
  await r.orchestrator.clarify('t-a', [{ question_id: 'Q1', answer: 'magic link' }], 'human');
  expect(r.orchestrator.respond('t-a', accept(2)).status).toBe('work_started');
  r.orchestrator.reportBlocker('t-a', { reason: 'which sender?', waiting_on: 'human' });
  r.orchestrator.reply('t-a', 'use the stub', 'human');
  expect((await r.orchestrator.awaitReply('t-a', 1)).status).toBe('replied');
  r.orchestrator.reportProgress('t-a', { message: 'halfway' });
  r.orchestrator.submitEvidence('t-a', { contract_version: 2, claimed: claimedAll, summary: 'done?' });
  await r.orchestrator.settled();
  expect(await r.orchestrator.awaitVerdict('t-a', 1, 1)).toEqual({ status: 'pending', pending_criteria: ['AC-3'] });

  await r.orchestrator.proposeTask(mission_id, sampleContract('t-b'), 'planner');
  r.orchestrator.respond('t-b', accept(1));
  r.orchestrator.submitEvidence('t-b', { contract_version: 1, claimed: claimedAll, summary: 'done' });
  await r.orchestrator.settled();
  expect(r.orchestrator.taskView('t-b')!.task_state).toBe('completed');

  await r.orchestrator.proposeTask(mission_id, sampleContract('t-c', { runtime: 'codex' }), 'planner');
  r.orchestrator.respond('t-c', accept(1));
  await r.orchestrator.settled();
  tracker.stop();
  return { r, runDir, mission_id };
}

function secondRun(dir: string) {
  const r = createTestRelay({ dir, script });
  const runDir = path.join(dir, 'run');
  return { r, runDir };
}

const restore = (r: TestRelay, runDir: string, hostKind: 'fake' | 'relay' | 'tmux' | 'herdr' = 'fake') =>
  restoreRun({ store: r.store, orchestrator: r.orchestrator, runDir, relayDir: path.join(r.dir, '.relay'), hostKind, log: () => {} });

describe('rehydrate', () => {
  it('rebuilds the task views from the event log; await_verdict resumes after the human passes AC-3; seq continues', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const { r: r1, runDir, mission_id } = await firstRun(dir);
    const before = r1.orchestrator.taskView('t-a')!;
    const seqBefore = r1.store.all().at(-1)!.seq;
    const oldToken = r1.orchestrator.tokenFor('t-a')!;

    const { r } = secondRun(dir);
    expect(r.store.all().at(-1)!.seq).toBe(seqBefore); // the same log, reopened
    const result = await restore(r, runDir);
    expect(result).toMatchObject({ missions: 1, tasks: 3 });

    const after = r.orchestrator.taskView('t-a')!;
    expect(after.task_state).toBe('awaiting_verification');
    expect(after.handoff_state).toBe('evidence_submitted');
    expect(after.contract.version).toBe(2);
    expect(after.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(after.attempt).toBe(1);
    expect(after.open_questions).toEqual([]);
    expect(after.response?.decision).toBe('accepted');
    expect(after.replies).toEqual(before.replies);
    expect(after.worktree).toEqual(before.worktree);
    expect(after.attempts).toEqual(before.attempts);
    // Everything but the pane that was (necessarily) replaced and the timestamps.
    expect(stable({ ...after, agent: before.agent, runtime: before.runtime })).toEqual(stable(before));
    expect(r.orchestrator.listTasks(mission_id).map((t) => [t.id, t.task_state, t.attempt])).toEqual([['t-a', 'awaiting_verification', 1], ['t-b', 'completed', 1], ['t-c', 'executing', 0]]);
    expect(r.orchestrator.getMission(mission_id)).toMatchObject({ status: 'executing', task_ids: ['t-a', 't-b', 't-c'] });
    expect(r.orchestrator.taskView('t-c')!.contract.runtime).toBe('codex');

    // Tokens are re-issued, never persisted.
    const newToken = r.orchestrator.tokenFor('t-a')!;
    expect(newToken).not.toBe(oldToken);
    expect(r.orchestrator.resolveToken(oldToken)).toBeUndefined();
    expect(r.orchestrator.resolveToken(newToken)).toEqual({ kind: 'task', taskId: 't-a' });
    const plannerToken = r.runtimes['claude-code'].calls.find((c) => c.spec.role === 'planner')!.spec.token;
    expect(r.orchestrator.resolveToken(plannerToken)).toEqual({ kind: 'mission', missionId: mission_id });

    // The pending human review survives the restart: await_verdict resolves once AC-3 passes.
    expect(await r.orchestrator.awaitVerdict('t-a', 1, 1)).toEqual({ status: 'pending', pending_criteria: ['AC-3'] });
    const poll = r.orchestrator.awaitVerdict('t-a', 1, 5);
    await r.orchestrator.review('t-a', { criterion_id: 'AC-3', status: 'passed' });
    expect(await poll).toEqual({ status: 'verified' });
    expect(r.orchestrator.taskView('t-a')!.task_state).toBe('completed');

    // Numbering continues after the last recorded seq; nothing is reused.
    const seqs = r.store.all().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(seqs.at(-1)!).toBeGreaterThan(seqBefore);
    expect(r.store.all().filter((e) => e.type === 'task_verified').map((e) => e.task_id)).toEqual(['t-b', 't-a']);
    const reopened = createTestRelay({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')) });
    expect(reopened.store.all()).toEqual([]);
  });

  it('rehydrate restores repair bookkeeping (active repair awaiting acknowledgement) and refuses a non-empty orchestrator', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const r1 = createTestRelay({ dir, script: { 'AC-2': 'failed' } });
    const { mission_id } = r1.orchestrator.createMission(mission);
    await r1.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
    r1.orchestrator.respond('t-a', accept(1));
    r1.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's' });
    expect((await r1.orchestrator.awaitVerdict('t-a', 1, 5)).status).toBe('repair');

    const { r, runDir } = secondRun(dir);
    await restore(r, runDir);
    const view = r.orchestrator.taskView('t-a')!;
    expect(view.handoff_state).toBe('retry_requested');
    expect(view.active_repair?.id).toBe('t-a/r1');
    expect(view.repairs).toHaveLength(1);
    expect((await r.orchestrator.awaitVerdict('t-a', 1, 1)).status).toBe('repair');
    // The resumed agent's first relay_get_contract acknowledges the repair, exactly as before the restart.
    expect(r.orchestrator.getContract('t-a').active_repair?.id).toBe('t-a/r1');
    expect(r.store.all().filter((e) => e.type === 'repair_accepted')).toHaveLength(1);
    expect(r.orchestrator.taskView('t-a')!.task_state).toBe('repairing');
    expect(() => r.orchestrator.rehydrate(r.store.all())).toThrow(/empty/);
  });

  it('rehydrate keeps unread replies for a still-open blocker and canceled/failed tasks terminal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const r1 = createTestRelay({ dir });
    const { mission_id } = r1.orchestrator.createMission(mission);
    await r1.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
    await r1.orchestrator.proposeTask(mission_id, sampleContract('t-b'), 'planner');
    r1.orchestrator.respond('t-a', accept(1));
    r1.orchestrator.reportBlocker('t-a', { reason: 'need input', waiting_on: 'human' });
    r1.orchestrator.reply('t-a', 'first', 'human');
    r1.orchestrator.reply('t-a', 'second', 'human');
    await r1.orchestrator.cancel('t-b', 'not needed');

    const { r, runDir } = secondRun(dir);
    await restore(r, runDir);
    expect(r.orchestrator.taskView('t-a')!.blocker).toMatchObject({ reason: 'need input', waiting_on: 'human' });
    expect(await r.orchestrator.awaitReply('t-a', 1)).toMatchObject({ status: 'replied', message: 'first' });
    expect(await r.orchestrator.awaitReply('t-a', 1)).toMatchObject({ status: 'replied', message: 'second' });
    expect(r.orchestrator.taskView('t-b')!.task_state).toBe('canceled');
    await expect(r.orchestrator.reviseTask('t-b', { goal: 'x' }, 'planner')).rejects.toMatchObject({ status: 409 });
  });
});

describe('respawn', () => {
  it('respawns alive, non-terminal panes via runtime.resume with the recorded session id and records failures as task_blocked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const { r: r1, runDir, mission_id } = await firstRun(dir);
    const ws1 = readWorkspace(runDir)!;
    expect(ws1.panes.map((p) => [p.task_id, p.alive])).toEqual([[`planner:${mission_id}`, true], ['t-a', true], ['t-b', true], ['t-c', true]]);
    const sessionOf = (taskId: string) => ws1.panes.find((p) => p.task_id === taskId)!.session_id;
    const oldPaneOf = (taskId: string) => ws1.panes.find((p) => p.task_id === taskId)!.pane_id;
    const seqBefore = r1.store.all().at(-1)!.seq;

    const { r } = secondRun(dir);
    r.runtimes.codex.resume = async () => { throw new Error('codex exploded'); };
    const tracker = createWorkspaceTracker({ store: r.store, runDir, runId: 'run-1', repo: '/repo', relayDir: path.join(r.dir, '.relay'), host: r.host, schedule: noSchedule });
    const result = await restore(r, runDir);
    tracker.stop();

    expect(result).toMatchObject({ missions: 1, tasks: 3, respawned: [`planner:${mission_id}`, 't-a'], skipped: ['t-b'], failed: [{ task_id: 't-c', error: expect.stringContaining('codex exploded') }] });

    // Planner + t-a respawned through runtime.resume with the recorded session ids and the resume prompt.
    const claudeCalls = r.runtimes['claude-code'].calls;
    expect(claudeCalls.map((c) => [c.mode, c.spec.role, c.spec.sessionId])).toEqual([['resume', 'planner', sessionOf(`planner:${mission_id}`)], ['resume', 'recipient', sessionOf('t-a')]]);
    expect(claudeCalls[1].spec).toMatchObject({ taskId: 't-a', cwd: '/tmp/fake/t-a', mcpUrl: 'http://127.0.0.1:0/mcp', token: r.orchestrator.tokenFor('t-a') });
    expect(claudeCalls[1].configDir).toBe(path.join(r.dir, '.relay', 'agents', 't-a'));
    expect(claudeCalls[0].configDir).toBe(path.join(r.dir, '.relay', 'agents', `planner-${mission_id}`));
    expect(r.host.calls.spawn.map((s) => [s.name, s.argv, s.prompt])).toEqual([
      ['planner', ['fake-agent', 'resume', sessionOf(`planner:${mission_id}`)], RESUME_PROMPT],
      ['a', ['fake-agent', 'resume', sessionOf('t-a')], RESUME_PROMPT],
    ]);
    expect(r.host.calls.spawn[1].env.RELAY_TOKEN).toBe(r.orchestrator.tokenFor('t-a'));

    // Events: every old pane exited (daemon restart), the two resumed ones spawned again, t-c blocked.
    const fresh = r.store.all().filter((e) => e.seq > seqBefore);
    expect(fresh.map((e) => [e.type, e.task_id ?? 'planner'])).toEqual([
      ['agent_exited', 'planner'], ['agent_spawned', 'planner'],
      ['agent_exited', 't-a'], ['agent_spawned', 't-a'],
      ['agent_exited', 't-b'],
      ['agent_exited', 't-c'], ['task_blocked', 't-c'],
    ]);
    const exited = fresh.filter((e) => e.type === 'agent_exited');
    expect(exited.map((e) => e.payload)).toEqual([oldPaneOf(`planner:${mission_id}`), oldPaneOf('t-a'), oldPaneOf('t-b'), oldPaneOf('t-c')].map((pane_id) => ({ pane_id, exit_reason: 'daemon restart' })));
    const spawned = fresh.filter((e) => e.type === 'agent_spawned');
    expect(spawned[1].payload).toEqual({ runtime: 'claude-code', pane_id: '%fake-2', session_id: sessionOf('t-a'), cwd: '/tmp/fake/t-a' });
    expect(fresh.find((e) => e.type === 'task_blocked')!.payload).toEqual({ reason: 'resume failed: codex exploded' });

    const a = r.orchestrator.taskView('t-a')!;
    expect(a.agent).toEqual({ runtime: 'claude-code', pane_id: '%fake-2', session_id: sessionOf('t-a') });
    expect(a.runtime).toBe('idle');
    expect(a.task_state).toBe('awaiting_verification');
    expect(r.orchestrator.taskView('t-b')!.task_state).toBe('completed');
    expect(r.orchestrator.taskView('t-c')!.blocker?.reason).toBe('resume failed: codex exploded');
    expect(r.store.state().tasks['t-c'].runtime).toBe('blocked');

    // The workspace now lists the old panes as dead and the new ones as alive.
    const ws2 = readWorkspace(runDir)!;
    expect(ws2.panes.map((p) => [p.pane_id, p.task_id, p.alive])).toEqual([
      [oldPaneOf(`planner:${mission_id}`), `planner:${mission_id}`, false], [oldPaneOf('t-a'), 't-a', false], [oldPaneOf('t-b'), 't-b', false], [oldPaneOf('t-c'), 't-c', false],
      ['%fake-1', `planner:${mission_id}`, true], ['%fake-2', 't-a', true],
    ]);
    expect(ws2.panes[5].session_id).toBe(sessionOf('t-a'));

    // A second planner cannot be started while the resumed one is alive; the resumed task keeps working.
    await expect(r.orchestrator.spawnPlanner(mission_id, 'codex')).rejects.toThrow(/already has a planner/);
    r.orchestrator.reportProgress('t-a', { message: 'back' });
    expect(r.orchestrator.taskView('t-a')!.runtime).toBe('working');
  });

  it('respawn skips panes that are not alive and marks every pane exited on tmux/herdr hosts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const { runDir, mission_id } = await firstRun(dir);
    const ws = readWorkspace(runDir)!;
    writeWorkspace(runDir, { ...ws, panes: ws.panes.map((p) => (p.task_id === 't-a' ? { ...p, alive: false } : p)) });

    const { r } = secondRun(dir);
    const seqBefore = r.store.all().at(-1)!.seq;
    const result = await restore(r, runDir, 'tmux');
    expect(result.respawned).toEqual([]);
    expect(result.skipped).toEqual([`planner:${mission_id}`, 't-b', 't-c']);
    expect(r.host.calls.spawn).toEqual([]);
    const fresh = r.store.all().filter((e) => e.seq > seqBefore);
    expect(fresh.map((e) => [e.type, e.task_id ?? 'planner'])).toEqual([['agent_exited', 'planner'], ['agent_exited', 't-b'], ['agent_exited', 't-c']]);
    expect(fresh[2].payload).toMatchObject({ exit_reason: expect.stringContaining('tmux') });
    expect(r.store.state().tasks['t-c'].runtime).toBe('exited');
  });

  it('respawn falls back to the event log when workspace.json is missing and does not respawn a planner of a finished mission', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const { r: r1, runDir, mission_id } = await firstRun(dir);
    fs.rmSync(path.join(runDir, 'workspace.json'));
    // Finish the mission: AC-3 passes, t-c submits, integration verifies.
    await r1.orchestrator.review('t-a', { criterion_id: 'AC-3', status: 'passed' });
    r1.orchestrator.submitEvidence('t-c', { contract_version: 1, claimed: claimedAll, summary: 'done' });
    await r1.orchestrator.settled();
    expect(r1.orchestrator.getMission(mission_id)!.status).toBe('verified');

    const { r } = secondRun(dir);
    const result = await restore(r, runDir);
    expect(result.respawned).toEqual([]);
    expect(result.skipped).toEqual([`planner:${mission_id}`, 't-a', 't-b', 't-c']);
    expect(r.orchestrator.getMission(mission_id)!.status).toBe('verified');
    await expect(r.orchestrator.respawn('t-a')).rejects.toMatchObject({ status: 409 });
  });

  it('orchestrator.respawn refuses tasks without a recorded session and runtimes that cannot resume', async () => {
    const r = createTestRelay();
    const { mission_id } = r.orchestrator.createMission(mission);
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-a', { dependencies: ['t-zzz'] }), 'planner');
    await expect(r.orchestrator.respawn('t-zzz')).rejects.toMatchObject({ status: 404 });
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-b'), 'planner');
    delete (r.runtimes['claude-code'] as { resume?: unknown }).resume;
    await expect(r.orchestrator.respawn('t-b')).rejects.toThrow(/cannot resume/);
    await expect(r.orchestrator.respawn(`planner:${mission_id}`)).rejects.toMatchObject({ status: 409 });
  });
});

describe('resume run id', () => {
  it('latestRunId picks the run whose events.jsonl is newest; resolveResumeEnv maps RELAY_RESUME=latest to RELAY_RUN_ID', () => {
    const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    expect(latestRunId(relayDir)).toBeUndefined();
    for (const [id, age] of [['run-old', 60_000], ['run-new', 1000], ['empty', 0]] as const) {
      fs.mkdirSync(path.join(relayDir, 'runs', id), { recursive: true });
      if (id === 'empty') continue;
      const f = path.join(relayDir, 'runs', id, 'events.jsonl');
      fs.writeFileSync(f, '');
      fs.utimesSync(f, new Date(Date.now() - age), new Date(Date.now() - age));
    }
    expect(latestRunId(relayDir)).toBe('run-new');
    expect(resolveResumeEnv({ RELAY_RESUME: 'latest', RELAY_DIR: relayDir })).toMatchObject({ RELAY_RUN_ID: 'run-new' });
    expect(resolveResumeEnv({ RELAY_RESUME: 'latest', RELAY_RUN_ID: 'run-old', RELAY_DIR: relayDir }).RELAY_RUN_ID).toBe('run-old');
    expect(resolveResumeEnv({ RELAY_DIR: relayDir }).RELAY_RUN_ID).toBeUndefined();
    expect(() => resolveResumeEnv({ RELAY_RESUME: 'latest', RELAY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')) })).toThrow(/no recorded run/);
  });
});
