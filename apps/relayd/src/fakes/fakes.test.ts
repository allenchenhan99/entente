import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskContract } from '@relay/protocol';
import type { TaskView, EvidenceSubmission, EvidenceRecord } from '@relay/protocol';
import { createJsonlStore } from '../store/jsonl-store.js';
import { fakeWorktrees } from './worktrees.js';
import { fakeChecks } from './checks.js';
import { fakeRepair } from './repair.js';
import { fakeHost } from './host.js';
import { fakeRuntime } from './runtime.js';

const contract = TaskContract.parse({
  id: 't-a', mission_id: 'm-1', version: 1, sender: 'planner', recipient: 'backend', runtime: 'claude-code',
  goal: 'g', non_goals: ['UI'],
  acceptance_criteria: [
    { id: 'AC-1', condition: 'one', check: { kind: 'command', run: 'true' } },
    { id: 'AC-2', condition: 'two', check: { kind: 'command', run: 'true' } },
    { id: 'AC-3', condition: 'three', check: { kind: 'human_review' } },
  ],
  budget: { max_repairs: 1 },
});
const view = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't-a', mission_id: 'm-1', contract, versions: [contract], open_questions: [], lint: [],
  runtime: 'working', task_state: 'awaiting_verification', handoff_state: 'evidence_submitted',
  blocked_on_dependencies: [], attempt: 1, attempts: [], repairs: [], escalated: false, ...over,
});
const submission = (): EvidenceSubmission => ({
  task_id: 't-a', contract_version: 1, attempt: 1, summary: 's',
  claimed: { 'AC-1': { status: 'passed' }, 'AC-2': { status: 'passed' }, 'AC-3': { status: 'passed' } },
});
const wt = { path: '/tmp/fake/t-a', branch: 'relay/t-a', base: 'main' };

describe('fakes', () => {
  it('fakeWorktrees records create calls and returns a deterministic worktree', async () => {
    const w = fakeWorktrees();
    const info = await w.create('/repo', contract, ['relay/t-dep']);
    expect(info).toEqual(wt);
    expect(w.calls.create).toEqual([{ repoRoot: '/repo', taskId: 't-a', dependencyBranches: ['relay/t-dep'] }]);
    expect(await w.integrate('/repo', ['relay/t-a'])).toEqual({ branch: 'relay/integration' });
    const conflicting = fakeWorktrees({ conflict: { branch: 'relay/t-a', files: ['x.ts'] } });
    expect(await conflicting.integrate('/repo', ['relay/t-b', 'relay/t-a'])).toEqual({
      branch: 'relay/integration', conflict: { branch: 'relay/t-a', files: ['x.ts'] },
    });
  });

  it('fakeChecks emits check events through the store and computes self_report_mismatch', async () => {
    const store = createJsonlStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')) });
    const checks = fakeChecks({ 'AC-1': 'passed', 'AC-2': 'failed', 'AC-3': 'pending_human' }, store);
    const record = await checks.run(view(), submission(), wt, '/tmp/ev');
    expect(record.checks['AC-1'].status).toBe('passed');
    expect(record.checks['AC-2'].status).toBe('failed');
    expect(record.checks['AC-2'].observed).toBeTruthy();
    expect(record.checks['AC-3'].status).toBe('pending_human');
    expect(record.self_report_mismatch).toEqual(['AC-2']);
    expect(record.attempt).toBe(1);
    expect(store.all().map((e) => e.type)).toEqual(['check_passed', 'check_failed']);
    expect(store.all()[1].payload).toMatchObject({ attempt: 1, criterion_id: 'AC-2' });
    // criteria absent from the script pass by default
    checks.script = {};
    const again = await checks.run(view(), { ...submission(), attempt: 2 }, wt, '/tmp/ev');
    expect(Object.values(again.checks).every((c) => c.status === 'passed')).toBe(true);
  });

  it('fakeRepair implements the simple ladder', () => {
    const policy = fakeRepair();
    const rec = (checks: EvidenceRecord['checks'], attempt = 1): EvidenceRecord => ({
      task_id: 't-a', contract_version: 1, attempt, checks, changed_files: [], self_report_mismatch: [],
    });
    const ok = { status: 'passed' as const };
    expect(policy.decide(view(), rec({ 'AC-1': ok, 'AC-2': ok, 'AC-3': ok }))).toEqual({ kind: 'verified' });
    const d = policy.decide(view(), rec({ 'AC-1': ok, 'AC-2': { status: 'failed', observed: 'boom' }, 'AC-3': ok }));
    expect(d.kind).toBe('repair');
    if (d.kind !== 'repair') throw new Error();
    expect(d.repair).toMatchObject({ id: 't-a/r1', parent_task: 't-a', parent_version: 1, attempt: 2, failed_criteria: ['AC-2'], remaining_repairs: 0 });
    expect(d.repair.observed_failure).toContain('boom');
    expect(d.repair.unchanged_scope).toEqual(['UI']);
    expect(policy.decide(view(), rec({ 'AC-1': ok, 'AC-2': { status: 'failed' }, 'AC-3': ok }, 2)).kind).toBe('failed_budget');
    expect(policy.decide(view(), rec({ 'AC-1': ok, 'AC-2': ok, 'AC-3': { status: 'pending_human' } }))).toEqual({ kind: 'pending_human', criteria: ['AC-3'] });
    // a task without a budget defaults to 3 repairs
    const noBudget = view({ contract: { ...contract, budget: undefined } });
    expect(policy.decide(noBudget, rec({ 'AC-1': { status: 'failed' } }, 3)).kind).toBe('repair');
    expect(policy.decide(noBudget, rec({ 'AC-1': { status: 'failed' } }, 4)).kind).toBe('failed_budget');
  });

  it('fakeHost records spawns and kills', async () => {
    const host = fakeHost();
    expect(host.kind).toBe('relay');
    const { paneId } = await host.spawn({ name: 'backend', cwd: '/w', argv: ['x'], env: {} });
    expect(host.calls.spawn).toHaveLength(1);
    expect(await host.isAlive(paneId)).toBe(true);
    await host.kill(paneId);
    expect(await host.isAlive(paneId)).toBe(false);
    expect(host.calls.kill).toEqual([paneId]);
  });

  it('fakeRuntime returns an argv carrying the token and records the spec', async () => {
    const rt = fakeRuntime('codex');
    expect(rt.kind).toBe('codex');
    const spec = { taskId: 't-a', token: 'tok', mcpUrl: 'http://x/mcp', sessionId: 's', cwd: '/w', role: 'recipient' as const, contractSummary: 'g' };
    const launch = await rt.prepare(spec, '/cfg');
    expect(launch.argv[0]).toBeTruthy();
    expect(launch.env.RELAY_TOKEN).toBe('tok');
    expect(rt.calls).toEqual([{ spec, configDir: '/cfg' }]);
  });
});
