import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GitWorktreeManager } from '../worktree/git-worktrees.js';
import { afterEach, expect, it } from 'vitest';
import { createTestRelay, sampleContract } from '../fakes/test-harness.js';
const relays: ReturnType<typeof createTestRelay>[] = [];
afterEach(async () => { for (const r of relays.splice(0)) { await r.orchestrator.settled(); fs.rmSync(r.dir, { recursive: true, force: true }); } });
const fact = { id: 'a', text: 'initial understanding', tags: ['context'], sources: [] };
const selector = { ids: ['a'], tags: [], max_bytes: 900 };

it('assigns a later child the committed parent-only report and current source freshness', async () => {
  const r = createTestRelay(); relays.push(r);
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(r.dir, ['init', '-b', 'main']);
  git(r.dir, ['config', 'user.name', 'Test']);
  git(r.dir, ['config', 'user.email', 'test@example.com']);
  git(r.dir, ['commit', '--allow-empty', '-m', 'baseline']);
  const manager = new GitWorktreeManager();
  r.worktrees.create = manager.create.bind(manager);
  const { mission_id } = r.orchestrator.createMission({ repo: r.dir, title: 'Parent report handoff' });
  await r.orchestrator.proposeTask(mission_id, sampleContract('t-parent'), 'planner');
  const parent = r.orchestrator.getContract('t-parent').worktree!;
  await r.orchestrator.proposeSubtask('t-parent', sampleContract('t-first'));
  const first = r.orchestrator.getContract('t-first').worktree!;
  const report = 'first child report\n';
  fs.writeFileSync(path.join(first.path, 'report.md'), report);
  await manager.commitAll(first.path, 'first report');
  expect(await manager.mergeBranch(parent.path, first.branch)).toMatchObject({ merged: true });
  expect(fs.existsSync(path.join(r.dir, 'report.md'))).toBe(false);
  fs.writeFileSync(path.join(parent.path, 'uncommitted.md'), 'filesystem only');
  fs.writeFileSync(path.join(r.dir, 'root-only.md'), 'unrelated');
  const source = { path: 'report.md', sha256: createHash('sha256').update(report).digest('hex') };
  r.orchestrator.checkpoint({ kind: 'task', taskId: 't-parent' }, { operation: 'update', expected_revision: 0, upsert: [{ ...fact, sources: [source] }], remove: [] });
  const proposed = await r.orchestrator.proposeSubtask('t-parent', sampleContract('t-second', { inputs: ['report.md'], context: selector }));
  expect(proposed.status).toBe('proposed');
  const assigned = r.orchestrator.getContract('t-second');
  expect(assigned.context?.entries[0].source_status).toBe('current');
  expect(assigned.context_validation).toEqual({ a: 'current' });
  expect(fs.readFileSync(path.join(assigned.worktree!.path, 'report.md'), 'utf8')).toBe(report);
  expect(fs.existsSync(path.join(assigned.worktree!.path, 'uncommitted.md'))).toBe(false);
  const missing = await r.orchestrator.proposeSubtask('t-parent', sampleContract('t-missing', { inputs: ['root-only.md'] }));
  expect(missing).toMatchObject({ status: 'lint_error', errors: [expect.stringContaining('missing_input')] });
  const escaped = await r.orchestrator.proposeSubtask('t-parent', sampleContract('t-escape', {
    inputs: [path.join(r.dir, 'root-only.md'), path.relative(parent.path, path.join(r.dir, 'root-only.md'))],
  }));
  expect(escaped).toMatchObject({ status: 'lint_error', errors: [expect.stringContaining('missing_input'), expect.stringContaining('missing_input')] });
  // Planner assignments still inspect the global root.
  r.orchestrator.checkpoint({ kind: 'mission', missionId: mission_id }, { operation: 'update', expected_revision: 0, upsert: [{ ...fact, sources: [source] }], remove: [] });
  await r.orchestrator.proposeTask(mission_id, sampleContract('t-root', { inputs: ['root-only.md'], context: selector }), 'planner');
  expect(r.orchestrator.getContract('t-root').context?.entries[0].source_status).toBe('missing');
});

it('marks checkpoint work as resumed activity after a synchronization blocker', async () => {
  const r = createTestRelay(); relays.push(r);
  const { mission_id } = r.orchestrator.createMission({ repo: r.dir, title: 'Visible checkpoint activity' });
  await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
  r.orchestrator.reportBlocker('t-a', { reason: 'Await next assignment', waiting_on: 'study-ready-0' });
  r.orchestrator.checkpoint({ kind: 'task', taskId: 't-a' }, { operation: 'update', expected_revision: 0, upsert: [fact], remove: [] });
  expect(r.orchestrator.taskView('t-a')!.blocker).toBeUndefined();
  expect(r.orchestrator.taskView('t-a')!.runtime).toBe('working');
  expect(r.ofType('task_unblocked')).toHaveLength(1);
});

it('restores the delivered revision and pending proposal after the owner advances', async () => {
  const r = createTestRelay(); relays.push(r);
  const { mission_id } = r.orchestrator.createMission({ repo: r.dir, title: 'Persistent handoff' });
  const owner = { kind: 'mission' as const, missionId: mission_id };
  r.orchestrator.checkpoint(owner, { operation: 'update', expected_revision: 0, upsert: [fact], remove: [] });
  await r.orchestrator.proposeTask(mission_id, sampleContract('t-a', { context: selector }), 'planner');
  const original = r.orchestrator.getContract('t-a');
  r.orchestrator.proposeContextDelta('t-a', 1, 1, [ { ...fact, text: 'child finding' } ], []);
  r.orchestrator.checkpoint(owner, { operation: 'update', expected_revision: 1, upsert: [{ ...fact, text: 'new owner observation' }], remove: [] });
  const restored = createTestRelay({ dir: r.dir });
  restored.orchestrator.rehydrate(r.store.all());
  expect(restored.orchestrator.getContract('t-a').context).toEqual(original.context);
  expect(restored.orchestrator.checkpoint(owner, { operation: 'pending' })).toMatchObject({ proposals: [{ author: 't-a', base_revision: 1 }] });
  expect(restored.orchestrator.getContext('t-a', selector)).toMatchObject({ revision: 2, entries: [{ text: 'new owner observation' }] });
});

it('creates distinct packets on revision and task-id reuse, and supports removing context', async () => {
  const r = createTestRelay(); relays.push(r);
  const { mission_id } = r.orchestrator.createMission({ repo: r.dir, title: 'Versioned assignments' });
  const owner = { kind: 'mission' as const, missionId: mission_id };
  r.orchestrator.checkpoint(owner, { operation: 'update', expected_revision: 0, upsert: [fact], remove: [] });
  await r.orchestrator.proposeTask(mission_id, sampleContract('t-a', { context: selector }), 'planner');
  const first = r.orchestrator.getContract('t-a');
  r.orchestrator.checkpoint(owner, { operation: 'update', expected_revision: 1, upsert: [{ ...fact, text: 'revised observation' }], remove: [] });
  await r.orchestrator.reviseTask('t-a', { goal: 'Use revised understanding' }, 'planner');
  const revised = r.orchestrator.getContract('t-a');
  expect(revised.contract.context_id).not.toBe(first.contract.context_id);
  expect(revised.context).toMatchObject({ revision: 2, entries: [{ text: 'revised observation' }] });
  await r.orchestrator.reviseTask('t-a', { context: null }, 'planner');
  expect(r.orchestrator.getContract('t-a').context).toBeUndefined();
  await r.orchestrator.cancel('t-a');
  await r.orchestrator.deleteTask('t-a');
  await r.orchestrator.proposeTask(mission_id, sampleContract('t-a', { context: selector }), 'planner');
  const reused = r.orchestrator.getContract('t-a');
  expect(reused.contract.version).toBe(1);
  expect(reused.contract.context_id).not.toBe(first.contract.context_id);
  expect(reused.context?.revision).toBe(2);
});

it('refuses proposals and acceptance based on a superseded or canceled assignment', async () => {
  const r = createTestRelay(); relays.push(r);
  const { mission_id } = r.orchestrator.createMission({ repo: r.dir, title: 'Stale contract proposal' });
  const owner = { kind: 'mission' as const, missionId: mission_id };
  r.orchestrator.checkpoint(owner, { operation: 'update', expected_revision: 0, upsert: [fact], remove: [] });
  await r.orchestrator.proposeTask(mission_id, sampleContract('t-a', { context: selector }), 'planner');
  const proposed = r.orchestrator.proposeContextDelta('t-a', 1, 1, [{ ...fact, text: 'child finding' }], []) as { id: string };
  await r.orchestrator.reviseTask('t-a', { goal: 'Changed requirements' }, 'planner');
  expect(() => r.orchestrator.proposeContextDelta('t-a', 1, 1, [fact], [])).toThrow(/contract_version/);
  expect(() => r.orchestrator.checkpoint(owner, { operation: 'review', proposal_id: proposed.id, expected_revision: 1, decision: 'accept' })).toThrow(/assignment/);
  expect(() => r.orchestrator.checkpoint(owner, { operation: 'review', proposal_id: proposed.id, expected_revision: 1, decision: 'reject' })).not.toThrow();
  await r.orchestrator.cancel('t-a');
  expect(() => r.orchestrator.proposeContextDelta('t-a', 2, 1, [fact], [])).toThrow(/canceled/);
});
