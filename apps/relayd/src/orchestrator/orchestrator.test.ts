import { describe, it, expect } from 'vitest';
import { createTestRelay, sampleContract } from '../fakes/test-harness.js';

const mission = { repo: '/repo', title: 'Add login' };

describe('orchestrator missions', () => {
  it('createMission emits mission_created with an m-<6hex> id and issues a planner token', () => {
    const r = createTestRelay();
    const { mission_id, planner_token } = r.orchestrator.createMission(mission);
    expect(mission_id).toMatch(/^m-[0-9a-f]{6}$/);
    expect(planner_token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.orchestrator.resolveToken(planner_token)).toEqual({ kind: 'mission', missionId: mission_id });
    expect(r.orchestrator.resolveToken('nope')).toBeUndefined();
    const ev = r.ofType('mission_created')[0];
    expect(ev.mission_id).toBe(mission_id);
    expect(ev.actor).toBe('human');
    expect(ev.payload).toMatchObject({ id: mission_id, repo: '/repo', title: 'Add login', integration_check: 'npx vitest run' });
  });

  it('spawnPlanner launches a planner agent in the repo root with the mission token, once per mission', async () => {
    const r = createTestRelay();
    const { mission_id, planner_token } = r.orchestrator.createMission(mission);
    const { pane_id } = await r.orchestrator.spawnPlanner(mission_id, 'claude-code');
    expect(pane_id).toBeTruthy();
    expect(r.host.calls.spawn[0]).toMatchObject({ name: 'planner', cwd: r.dir });
    const launch = r.runtimes['claude-code'].calls[0]!;
    expect(launch.spec).toMatchObject({ role: 'planner', token: planner_token, cwd: r.dir });
    expect(launch.spec.contractSummary).toContain(mission.title);
    const spawned = r.ofType('agent_spawned')[0];
    expect(spawned.task_id).toBeUndefined();
    expect(spawned.payload).toMatchObject({ runtime: 'claude-code', pane_id, cwd: r.dir });
    await expect(r.orchestrator.spawnPlanner(mission_id, 'codex')).rejects.toThrow(/already has a planner/);
    await expect(r.orchestrator.spawnPlanner('m-nope', 'codex')).rejects.toThrow(/not found/);
  });

  it('proposeTask rejects an unknown mission', async () => {
    const r = createTestRelay();
    await expect(r.orchestrator.proposeTask('m-nope', sampleContract('t-a'), 'planner')).rejects.toThrow(/mission/);
  });
});

describe('spawn gating', () => {
  it('a lint-clean proposal is linted, spawned and versioned 1', async () => {
    const r = createTestRelay();
    const { mission_id } = r.orchestrator.createMission(mission);
    const out = await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
    expect(out).toEqual({ status: 'proposed', task_id: 't-a', version: 1, warnings: [] });
    expect(r.types()).toEqual(['mission_created', 'task_proposed', 'lint_reported', 'worktree_created', 'agent_spawned']);
    const proposed = r.ofType('task_proposed')[0];
    expect(proposed.actor).toBe('planner');
    expect(proposed.payload.contract).toMatchObject({ id: 't-a', mission_id, version: 1, sender: 'planner', clarifications: [] });
    expect(r.ofType('lint_reported')[0].payload).toEqual({ contract_version: 1, results: [] });
    expect(r.ofType('worktree_created')[0].payload).toEqual({ path: '/tmp/fake/t-a', branch: 'relay/t-a', base: 'main' });
    const spawned = r.ofType('agent_spawned')[0];
    expect(spawned.payload).toMatchObject({ runtime: 'claude-code', cwd: '/tmp/fake/t-a' });
    expect(spawned.payload.pane_id).toBe(r.host.calls.spawn.length ? '%fake-1' : '');
    // the runtime was prepared with a token that resolves to the task
    const prep = r.runtimes['claude-code'].calls[0];
    expect(prep.configDir).toBe(`${r.dir}/.relay/agents/t-a`);
    expect(prep.spec).toMatchObject({ taskId: 't-a', role: 'recipient', cwd: '/tmp/fake/t-a', mcpUrl: 'http://127.0.0.1:0/mcp' });
    expect(r.orchestrator.resolveToken(prep.spec.token)).toEqual({ kind: 'task', taskId: 't-a' });
    expect(r.orchestrator.tokenFor('t-a')).toBe(prep.spec.token);
    expect(r.host.calls.spawn[0]).toMatchObject({ cwd: '/tmp/fake/t-a', argv: ['fake-agent', 'claude-code', 't-a'] });
  });

  it('a lint error blocks spawn until a fixed v2 is proposed for the same id, then spawns once', async () => {
    const r = createTestRelay();
    const { mission_id } = r.orchestrator.createMission(mission);
    const out = await r.orchestrator.proposeTask(mission_id, sampleContract('t-a', { acceptance_criteria: [] }), 'planner');
    expect(out.status).toBe('lint_error');
    if (out.status !== 'lint_error') throw new Error();
    expect(out.errors.length).toBeGreaterThan(0);
    const lint = r.ofType('lint_reported')[0];
    expect(lint.payload.results.some((x) => x.severity === 'error')).toBe(true);
    expect(r.host.calls.spawn).toHaveLength(0);
    expect(r.worktrees.calls.create).toHaveLength(0);

    const fixed = await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'human');
    expect(fixed).toMatchObject({ status: 'proposed', version: 2 });
    expect(r.ofType('task_proposed')[1].payload.contract.version).toBe(2);
    expect(r.ofType('task_proposed')[1].actor).toBe('human');
    expect(r.host.calls.spawn).toHaveLength(1);
    // re-proposing does not spawn twice
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'human');
    expect(r.host.calls.spawn).toHaveLength(1);
  });

  it('a task depending on another is spawned only after the dependency completes', async () => {
    const r = createTestRelay();
    const { mission_id } = r.orchestrator.createMission(mission);
    const early = await r.orchestrator.proposeTask(mission_id, sampleContract('t-b', { dependencies: ['t-a'] }), 'planner');
    // t-a is not known yet, so t-b's dependency is a lint error until t-a is proposed
    expect(early).toMatchObject({ status: 'lint_error', errors: [expect.stringContaining('unknown_dependency')] });
    expect(r.host.calls.spawn).toHaveLength(0);
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
    // proposing t-a re-lints its sibling t-b, which is now clean but still waits on the dependency
    const lints = r.ofType('lint_reported');
    expect(lints.map((e) => [e.task_id, e.payload.contract_version, e.payload.results.length])).toEqual([['t-b', 1, 1], ['t-a', 1, 0], ['t-b', 1, 0]]);
    expect(r.host.calls.spawn).toHaveLength(1);
    expect(r.host.calls.spawn[0].name).toBe('a');
    // drive t-a to completion through the fake checks
    r.orchestrator.respond('t-a', { contract_version: 1, decision: 'accepted', interpretation: ['x'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'run' }, questions: [] });
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: { 'AC-1': { status: 'passed' }, 'AC-2': { status: 'passed' } }, summary: 'done' });
    await r.orchestrator.settled();
    expect(r.ofType('task_completed').map((e) => e.task_id)).toEqual(['t-a']);
    expect(r.host.calls.spawn).toHaveLength(2);
    expect(r.host.calls.spawn[1].name).toBe('b');
    expect(r.worktrees.calls.create[1]).toEqual({ repoRoot: r.dir, taskId: 't-b', dependencyBranches: ['relay/t-a'] });
  });
});

const accept = { contract_version: 1, decision: 'accepted' as const, interpretation: ['x'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'run' }, questions: [] };
const claimedAll = { 'AC-1': { status: 'passed' as const }, 'AC-2': { status: 'passed' as const } };

async function spawnedTask(r: ReturnType<typeof createTestRelay>, id = 't-a', over = {}) {
  const { mission_id } = r.orchestrator.createMission(mission);
  const out = await r.orchestrator.proposeTask(mission_id, sampleContract(id, over), 'planner');
  expect(out.status).toBe('proposed');
  return mission_id;
}

describe('clarification', () => {
  it('needs_clarification → clarify builds v2 with clarifications and constraints appended, re-lints and wakes await_contract', async () => {
    const r = createTestRelay({ clock: () => '2026-09-04T10:00:00.000Z' });
    await spawnedTask(r);
    const waiting = r.orchestrator.respond('t-a', {
      contract_version: 1, decision: 'needs_clarification', interpretation: [], assumptions: [], risks: [], verification_plan: {},
      questions: [{ id: 'Q1', text: 'Which auth method?', blocking: true }, { id: 'Q2', text: 'Link TTL?', blocking: true }],
    });
    expect(waiting).toEqual({ status: 'waiting', open_questions: 2 });
    expect(r.ofType('clarification_requested')[0].actor).toBe('agent:a');
    expect(r.orchestrator.taskView('t-a')!.handoff_state).toBe('needs_clarification');

    const poll = r.orchestrator.awaitContract('t-a', 1, 5);
    const { contract_version } = await r.orchestrator.clarify('t-a', [{ question_id: 'Q1', answer: 'magic link' }, { question_id: 'Q2', answer: '15 minutes' }], 'human');
    expect(contract_version).toBe(2);
    const answered = r.ofType('clarification_answered')[0];
    expect(answered.actor).toBe('human');
    expect(answered.payload.answers).toEqual([
      { question_id: 'Q1', answer: 'magic link', answered_by: 'human', at: '2026-09-04T10:00:00.000Z' },
      { question_id: 'Q2', answer: '15 minutes', answered_by: 'human', at: '2026-09-04T10:00:00.000Z' },
    ]);
    const revised = r.ofType('contract_revised')[0];
    expect(revised.payload.previous_version).toBe(1);
    expect(revised.payload.contract.version).toBe(2);
    expect(revised.payload.contract.clarifications).toHaveLength(2);
    expect(revised.payload.contract.constraints).toEqual(['Keep it small', 'Which auth method?: magic link', 'Link TTL?: 15 minutes']);
    expect(r.ofType('lint_reported').map((e) => e.payload.contract_version)).toEqual([1, 2]);
    expect(await poll).toMatchObject({ status: 'revised', contract: { version: 2 } });
    // agent was already spawned; revision must not spawn again
    expect(r.host.calls.spawn).toHaveLength(1);
    // v1 responses are now invalid, v2 can be accepted
    expect(r.orchestrator.respond('t-a', accept)).toMatchObject({ status: 'invalid' });
    expect(r.orchestrator.respond('t-a', { ...accept, contract_version: 2 })).toMatchObject({ status: 'work_started', worktree: { path: '/tmp/fake/t-a', branch: 'relay/t-a' } });
    expect(r.types().slice(-2)).toEqual(['task_accepted', 'work_started']);
  });

  it('await_contract returns pending on timeout and canceled after cancel', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    expect(await r.orchestrator.awaitContract('t-a', 1, 1)).toEqual({ status: 'pending' });
    const poll = r.orchestrator.awaitContract('t-a', 1, 5);
    await r.orchestrator.cancel('t-a', 'nope');
    expect(await poll).toEqual({ status: 'canceled' });
    expect(r.host.calls.kill).toEqual(['%fake-1']);
    expect(r.ofType('task_canceled')[0].payload).toEqual({ reason: 'nope' });
  });

  it('await_contract stops early when the caller aborts', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    const ac = new AbortController();
    const poll = r.orchestrator.awaitContract('t-a', 1, 30, ac.signal);
    setTimeout(() => ac.abort(), 10);
    expect(await poll).toEqual({ status: 'pending' });
  });
});

describe('repair path', () => {
  it('self-report mismatch → repair_requested → await_verdict repair → repair_accepted on next get_contract → second attempt verified', async () => {
    const r = createTestRelay({ script: { 'AC-1': 'passed', 'AC-2': 'failed' } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    const sub = r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 'first' });
    expect(sub).toEqual({ attempt: 1, checks_started: true });
    expect(r.types().slice(-2)).toEqual(['evidence_submitted', 'checks_started']);
    const verdict = await r.orchestrator.awaitVerdict('t-a', 1, 5);
    expect(verdict.status).toBe('repair');
    if (verdict.status !== 'repair') throw new Error();
    expect(verdict.repair.failed_criteria).toEqual(['AC-2']);
    const recorded = r.ofType('evidence_recorded')[0];
    expect(recorded.payload.record.self_report_mismatch).toEqual(['AC-2']);
    expect(r.ofType('repair_requested')[0].payload.repair).toMatchObject({ id: 't-a/r1', attempt: 2, failed_criteria: ['AC-2'], remaining_repairs: 2 });
    expect(r.types().filter((t) => t === 'check_failed')).toHaveLength(1);

    // first get_contract after the repair carries active_repair and emits repair_accepted exactly once
    const got = r.orchestrator.getContract('t-a');
    expect(got.active_repair?.id).toBe('t-a/r1');
    r.orchestrator.getContract('t-a');
    r.orchestrator.reportProgress('t-a', { message: 'fixing' });
    expect(r.ofType('repair_accepted')).toHaveLength(1);
    expect(r.ofType('repair_accepted')[0].payload).toEqual({ repair_id: 't-a/r1' });
    expect(r.orchestrator.taskView('t-a')!.task_state).toBe('repairing');

    r.checks.script = { 'AC-1': 'passed', 'AC-2': 'passed' };
    expect(r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 'second' })).toEqual({ attempt: 2, checks_started: true });
    expect(await r.orchestrator.awaitVerdict('t-a', 2, 5)).toEqual({ status: 'verified' });
    await r.orchestrator.settled(); // task_completed follows the (async) worktree commit; integration then runs to the end
    const types = r.types();
    const recordedAt = types.lastIndexOf('evidence_recorded');
    expect(types.slice(recordedAt, recordedAt + 4)).toEqual(['evidence_recorded', 'task_verified', 'task_completed', 'integration_started']);
    expect(r.orchestrator.getContract('t-a').active_repair).toBeUndefined();
    // the earlier verdict is still retrievable
    expect((await r.orchestrator.awaitVerdict('t-a', 1, 1)).status).toBe('repair');
  });

  it('max_repairs 0 yields task_failed_budget and await_verdict failed_budget', async () => {
    const r = createTestRelay({ script: { 'AC-2': 'failed' } });
    await spawnedTask(r, 't-a', { budget: { max_repairs: 0, stagnation_limit: 2 } });
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's' });
    const v = await r.orchestrator.awaitVerdict('t-a', 1, 5);
    expect(v.status).toBe('failed_budget');
    expect(r.ofType('task_failed_budget')[0].payload.attempts).toBe(1);
    expect(r.ofType('repair_requested')).toHaveLength(0);
    expect(r.orchestrator.taskView('t-a')!.task_state).toBe('failed');
  });

  it('await_verdict returns pending with the pending criteria while a human review is outstanding', async () => {
    const r = createTestRelay({ script: { 'AC-2': 'pending_human' } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's' });
    await r.orchestrator.settled();
    expect(await r.orchestrator.awaitVerdict('t-a', 1, 1)).toEqual({ status: 'pending', pending_criteria: ['AC-2'] });
    expect(r.types().filter((t) => t.startsWith('task_'))).toEqual(['task_proposed', 'task_accepted']);
  });

  it('escalate decisions from the policy emit task_escalated', async () => {
    const r = createTestRelay({ script: { 'AC-2': 'failed' }, repair: { decide: () => ({ kind: 'escalate', reason: 'stagnation', failed_criteria: ['AC-2'] }) } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's' });
    expect(await r.orchestrator.awaitVerdict('t-a', 1, 5)).toEqual({ status: 'escalated', reason: 'stagnation' });
    expect(r.ofType('task_escalated')[0].payload).toEqual({ reason: 'stagnation', failed_criteria: ['AC-2'] });
    expect(r.orchestrator.taskView('t-a')!.escalated).toBe(true);
  });

  it('a throwing check runner escalates instead of hanging await_verdict', async () => {
    const r = createTestRelay();
    r.checks.run = async () => { throw new Error('git exploded'); };
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's' });
    expect(await r.orchestrator.awaitVerdict('t-a', 1, 5)).toMatchObject({ status: 'escalated', reason: expect.stringContaining('git exploded') });
  });
});

describe('human review', () => {
  it('merges the human verdict into the pending record and re-decides', async () => {
    const r = createTestRelay({ script: { 'AC-2': 'pending_human' } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's' });
    await r.orchestrator.settled();
    await expect(r.orchestrator.review('t-a', { criterion_id: 'AC-9', status: 'failed' })).rejects.toMatchObject({ status: 400 });
    await r.orchestrator.review('t-a', { criterion_id: 'AC-2', status: 'failed', observed_failure: 'link reused' });
    expect(r.ofType('human_review_recorded')[0].payload).toEqual({ attempt: 1, criterion_id: 'AC-2', status: 'failed', observed_failure: 'link reused' });
    const repair = r.ofType('repair_requested')[0].payload.repair;
    expect(repair.failed_criteria).toEqual(['AC-2']);
    expect(repair.observed_failure).toContain('link reused');
    expect(r.orchestrator.taskView('t-a')!.attempts[0].self_report_mismatch).toEqual(['AC-2']);
    // nothing is pending any more
    await expect(r.orchestrator.review('t-a', { criterion_id: 'AC-2', status: 'passed' })).rejects.toMatchObject({ status: 409 });

    r.checks.script = {};
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's2' });
    expect(await r.orchestrator.awaitVerdict('t-a', 2, 5)).toEqual({ status: 'verified' });
  });

  it('a passing human review completes the task', async () => {
    const r = createTestRelay({ script: { 'AC-2': 'pending_human' } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 's' });
    await r.orchestrator.settled();
    const poll = r.orchestrator.awaitVerdict('t-a', 1, 5);
    await r.orchestrator.review('t-a', { criterion_id: 'AC-2', status: 'passed' });
    expect(await poll).toEqual({ status: 'verified' });
    expect(r.ofType('task_completed')).toHaveLength(1);
    // The verified working tree is frozen into the branch before completion, so integration merges exactly what was checked.
    expect(r.worktrees.calls.commitAll).toEqual([{ worktreePath: '/tmp/fake/t-a', message: 'relay: verified evidence attempt 1 for t-a' }]);
    expect(r.types().indexOf('task_verified')).toBeLessThan(r.types().indexOf('task_completed'));
  });
});

describe('blockers and runtime state', () => {
  it('report_blocker sets blocked; the next non-await call unblocks once', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.reportBlocker('t-a', { reason: 'need creds', waiting_on: 'human' });
    expect(r.orchestrator.taskView('t-a')!.runtime).toBe('blocked');
    expect(r.orchestrator.taskView('t-a')!.blocker).toMatchObject({ reason: 'need creds', waiting_on: 'human' });
    await r.orchestrator.awaitContract('t-a', 1, 1);
    expect(r.ofType('task_unblocked')).toHaveLength(0);
    r.orchestrator.reportProgress('t-a', { message: 'got them' });
    r.orchestrator.reportProgress('t-a', { message: 'more' });
    expect(r.types().slice(-3)).toEqual(['task_unblocked', 'progress_reported', 'progress_reported']);
    expect(r.orchestrator.taskView('t-a')!.runtime).toBe('working');
    expect(r.orchestrator.taskView('t-a')!.blocker).toBeUndefined();
  });

  it('rejects unknown tasks with a 404-style error and rejected decisions end the handoff', async () => {
    const r = createTestRelay();
    expect(() => r.orchestrator.getContract('t-zzz')).toThrow(/not found/);
    await spawnedTask(r);
    expect(r.orchestrator.respond('t-a', { ...accept, decision: 'rejected', reason: 'out of scope' })).toEqual({ status: 'rejected' });
    expect(r.ofType('task_rejected')[0].payload.response.reason).toBe('out of scope');
    expect(r.orchestrator.taskView('t-a')!.handoff_state).toBe('rejected');
  });
});

describe('integration', () => {
  it('runs after every task completes, in dependency order, and verifies the mission', async () => {
    const r = createTestRelay();
    const { mission_id } = r.orchestrator.createMission(mission);
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-b', { dependencies: ['t-a'] }), 'planner');
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 'a' });
    await r.orchestrator.settled();
    expect(r.ofType('integration_started')).toHaveLength(0);
    r.orchestrator.respond('t-b', accept);
    r.orchestrator.submitEvidence('t-b', { contract_version: 1, claimed: claimedAll, summary: 'b' });
    await r.orchestrator.settled();
    expect(r.ofType('integration_started')[0].payload).toEqual({ branch: 'relay/integration', order: ['t-a', 't-b'] });
    expect(r.worktrees.calls.integrate).toEqual([['relay/t-a', 'relay/t-b']]);
    expect(r.checks.calls.at(-1)).toEqual({ taskId: 't-integration', attempt: 1 });
    expect(r.types().at(-1)).toBe('mission_verified');
    expect(r.orchestrator.getMission(mission_id)!.status).toBe('verified');
  });

  it('reports a conflict and fails the mission', async () => {
    const r = createTestRelay({ worktrees: { conflict: { branch: 'relay/t-a', files: ['src/x.ts'] } } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 'a' });
    await r.orchestrator.settled();
    expect(r.ofType('integration_conflict')[0].payload).toEqual({ task_id: 't-a', files: ['src/x.ts'] });
    expect(r.types().at(-1)).toBe('mission_failed');
  });

  it('fails the mission when the integration check fails', async () => {
    const r = createTestRelay({ script: { 'AC-0': 'failed' } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 'a' });
    await r.orchestrator.settled();
    expect(r.ofType('mission_failed')[0].payload.reason).toMatch(/integration check failed/);
  });
});
