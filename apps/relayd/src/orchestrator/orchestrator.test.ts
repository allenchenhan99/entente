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

  it('askHuman / clarifyMission / awaitAnswers: the planner waits until the human answers every open question', async () => {
    const r = createTestRelay();
    const { mission_id } = r.orchestrator.createMission(mission);
    expect(await r.orchestrator.awaitAnswers(mission_id, 1)).toEqual({ status: 'none' });
    expect(r.orchestrator.askHuman(mission_id, [{ id: 'Q1', text: 'Which mechanism?', blocking: true }, { id: 'Q2', text: 'Cookie?', blocking: true }])).toEqual({ status: 'waiting', open_questions: 2 });
    expect(r.orchestrator.getMission(mission_id)!.open_questions.map((q) => q.id)).toEqual(['Q1', 'Q2']);
    const pending = await r.orchestrator.awaitAnswers(mission_id, 1);
    expect(pending.status).toBe('pending');
    const poll = r.orchestrator.awaitAnswers(mission_id, 5);
    expect(() => r.orchestrator.clarifyMission(mission_id, [{ question_id: 'Q9', answer: 'x' }], 'human')).toThrow(/no open mission question Q9/);
    expect(r.orchestrator.clarifyMission(mission_id, [{ question_id: 'Q1', answer: 'magic link' }], 'human')).toEqual({ answered: 1, open_questions: 1 });
    expect(r.orchestrator.clarifyMission(mission_id, [{ question_id: 'Q2', answer: 'cookie' }], 'human')).toEqual({ answered: 1, open_questions: 0 });
    const answered = await poll;
    expect(answered.status).toBe('answered');
    if (answered.status === 'answered') expect(answered.answers.map((a) => a.answer)).toEqual(['magic link', 'cookie']);
    expect(r.types().filter((t) => t.startsWith('mission_clarification'))).toEqual(['mission_clarification_requested', 'mission_clarification_answered', 'mission_clarification_answered']);
    expect(r.orchestrator.getMission(mission_id)!.clarifications).toHaveLength(2);
  });

  it('reviseTask changes only the provided keys and refuses to touch a completed contract', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    const before = r.orchestrator.getContract('t-a').contract;
    const { contract_version } = await r.orchestrator.reviseTask('t-a', { constraints: [...before.constraints, 'Repo facts: no @types/node'] }, 'planner');
    const after = r.orchestrator.getContract('t-a').contract;
    expect(contract_version).toBe(2);
    expect(after.goal).toBe(before.goal);
    expect(after.acceptance_criteria).toEqual(before.acceptance_criteria);
    expect(after.scope.allowed_paths).toEqual(before.scope.allowed_paths);
    expect(after.constraints).toContain('Repo facts: no @types/node');
    expect(r.ofType('lint_reported').at(-1)!.payload.results).toEqual([]);

    r.orchestrator.respond('t-a', { ...accept, contract_version: 2 });
    r.orchestrator.submitEvidence('t-a', { contract_version: 2, claimed: claimedAll, summary: 's' });
    await r.orchestrator.settled();
    expect(r.orchestrator.taskView('t-a')!.task_state).toBe('completed');
    await expect(r.orchestrator.reviseTask('t-a', { constraints: ['late'] }, 'planner')).rejects.toThrow(/immutable/);
  });

  it('records a failed agent spawn as a blocker instead of leaving the task silently unspawned', async () => {
    const r = createTestRelay();
    const { mission_id } = r.orchestrator.createMission(mission);
    r.host.spawn = async () => { throw new Error('herdr host: agent start failed: boom'); };

    await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
    await r.orchestrator.settled();

    const blocked = r.ofType('task_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.task_id).toBe('t-a');
    expect(blocked[0]!.payload.reason).toMatch(/agent spawn failed: herdr host: agent start failed: boom/);
    expect(r.ofType('agent_spawned')).toHaveLength(0);
    // /state and the TUI are reducer-derived, so the blocker has to be visible there too.
    expect(r.store.state().tasks['t-a']!.blocker?.reason).toMatch(/agent spawn failed/);
    expect(r.orchestrator.taskView('t-a')!.blocker?.reason).toMatch(/agent spawn failed/);
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
    r.orchestrator.respond('t-a', { contract_version: 1, decision: 'accepted', interpretation: ['x'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'run', 'AC-2': 'diff' }, questions: [] });
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: { 'AC-1': { status: 'passed' }, 'AC-2': { status: 'passed' } }, summary: 'done' });
    await r.orchestrator.settled();
    expect(r.ofType('task_completed').map((e) => e.task_id)).toEqual(['t-a']);
    expect(r.host.calls.spawn).toHaveLength(2);
    expect(r.host.calls.spawn[1].name).toBe('b');
    expect(r.worktrees.calls.create[1]).toEqual({ repoRoot: r.dir, taskId: 't-b', dependencyBranches: ['relay/t-a'] });
  });
});

const accept = { contract_version: 1, decision: 'accepted' as const, interpretation: ['x'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'run', 'AC-2': 'diff' }, questions: [] };
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
  it('reply / awaitReply: the human answers a blocker and the agent receives it in order', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    expect(await r.orchestrator.awaitReply('t-a', 1)).toEqual({ status: 'none' });
    r.orchestrator.reportBlocker('t-a', { reason: 'which email sender?', waiting_on: 'human' });
    expect(await r.orchestrator.awaitReply('t-a', 1)).toEqual({ status: 'pending' });
    const poll = r.orchestrator.awaitReply('t-a', 5);
    expect(r.orchestrator.reply('t-a', 'use MemoryEmailSender', 'human')).toEqual({ delivered: true, unread: 1 });
    expect(await poll).toMatchObject({ status: 'replied', message: 'use MemoryEmailSender', replied_by: 'human' });
    expect(r.orchestrator.taskView('t-a')!.runtime).toBe('blocked'); // await_reply is not a heartbeat
    expect(r.orchestrator.taskView('t-a')!.replies).toHaveLength(1);
    r.orchestrator.reply('t-a', 'second', 'human');
    expect(await r.orchestrator.awaitReply('t-a', 1)).toMatchObject({ status: 'replied', message: 'second' });
    expect(r.ofType('blocker_replied')).toHaveLength(2);
    r.orchestrator.reportProgress('t-a', { message: 'continuing' });
    expect(await r.orchestrator.awaitReply('t-a', 1)).toEqual({ status: 'none' });
  });

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
    expect(r.checks.calls.at(-1)).toMatchObject({ taskId: 't-integration', attempt: 1 });
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

describe('subtask (agent networking)', () => {
  const child = (over = {}) => sampleContract('t-a-schema', over);

  it('proposeSubtask: task_proposed by agent:<parent role>, parent_task stored, lint runs, child spawns, no tasks_planned', async () => {
    const r = createTestRelay();
    const mission_id = await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    const out = await r.orchestrator.proposeSubtask('t-a', child());
    expect(out).toEqual({ status: 'proposed', task_id: 't-a-schema', version: 1, warnings: [] });
    const proposed = r.ofType('task_proposed').at(-1)!;
    expect(proposed.actor).toBe('agent:a');
    expect(proposed.task_id).toBe('t-a-schema');
    expect(proposed.payload.contract).toMatchObject({ id: 't-a-schema', mission_id, version: 1, sender: 'agent:a', parent_task: 't-a' });
    expect(r.ofType('lint_reported').map((e) => e.task_id)).toContain('t-a-schema');
    expect(r.host.calls.spawn.map((s) => s.name)).toEqual(['a', 'a-schema']);
    expect(r.types()).not.toContain('tasks_planned');
    expect(r.orchestrator.taskView('t-a-schema')!.contract.parent_task).toBe('t-a');
    // the reducer-derived state carries the link too: the contract is the only place it lives
    expect(r.store.state().tasks['t-a-schema']!.contract.parent_task).toBe('t-a');
    expect(r.orchestrator.getMission(mission_id)!.task_ids).toEqual(['t-a', 't-a-schema']);
  });

  it('a verified subtask is merged into the parent worktree, the parent is told, and its files count as in-scope for the parent', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    await r.orchestrator.proposeSubtask('t-a', child());
    await r.orchestrator.settled();
    const childId = child().id;
    r.orchestrator.respond(childId, { ...accept, contract_version: 1 });
    r.orchestrator.submitEvidence(childId, { contract_version: 1, claimed: claimedAll, summary: 'child done' });
    await r.orchestrator.settled();
    expect(r.orchestrator.taskView(childId)!.task_state).toBe('completed');
    expect(r.worktrees.calls.mergeBranch).toEqual([{ worktreePath: '/tmp/fake/t-a', branch: `relay/${childId}` }]);
    const told = r.ofType('progress_reported').filter((e) => e.task_id === 't-a' && e.actor === 'relayd');
    expect(told).toHaveLength(1);
    expect(told[0]!.payload.message).toContain(childId);
    // The check runner sees the child's paths as allowed for the parent.
    r.orchestrator.submitEvidence('t-a', { contract_version: 1, claimed: claimedAll, summary: 'parent done' });
    await r.orchestrator.settled();
    const seen = r.checks.calls.filter((c) => c.taskId === 't-a').at(-1)!.allowedPaths;
    for (const p of child().scope.allowed_paths) expect(seen).toContain(p);
  });

  it('a conflicting subtask merge blocks the parent with the conflicting files', async () => {
    const r = createTestRelay({ worktrees: { conflict: { branch: `relay/${child().id}`, files: ['src/x.ts'] } } });
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    await r.orchestrator.proposeSubtask('t-a', child());
    await r.orchestrator.settled();
    r.orchestrator.respond(child().id, { ...accept, contract_version: 1 });
    r.orchestrator.submitEvidence(child().id, { contract_version: 1, claimed: claimedAll, summary: 'child done' });
    await r.orchestrator.settled();
    expect(r.orchestrator.taskView('t-a')!.runtime).toBe('blocked');
    expect(r.orchestrator.taskView('t-a')!.blocker?.reason).toContain('src/x.ts');
  });

  it('a subtask whose allowed_paths overlap the parent is rejected with overlapping_scope at error severity before task_proposed', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    const out = await r.orchestrator.proposeSubtask('t-a', child({ scope: { allowed_paths: ['src/t-a/schema/**'] } }));
    expect(out).toEqual({ status: 'lint_error', task_id: 't-a-schema', errors: [expect.stringMatching(/^overlapping_scope: .*src\/t-a\/schema\/\*\*.*t-a/)], warnings: [] });
    expect(r.ofType('task_proposed').map((e) => e.task_id)).toEqual(['t-a']);
    expect(r.orchestrator.taskView('t-a-schema')).toBeUndefined();
    expect(r.host.calls.spawn).toHaveLength(1);
  });

  it('a subtask declaring its parent as a dependency is a 400 cycle', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    await expect(r.orchestrator.proposeSubtask('t-a', child({ dependencies: ['t-a'] }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/cycle/) });
    expect(r.ofType('task_proposed').map((e) => e.task_id)).toEqual(['t-a']);
  });

  it('proposeSubtask rejects an unknown or finished parent', async () => {
    const r = createTestRelay();
    await expect(r.orchestrator.proposeSubtask('t-zzz', child())).rejects.toMatchObject({ status: 404 });
    await spawnedTask(r);
    await r.orchestrator.cancel('t-a', 'nope');
    await expect(r.orchestrator.proposeSubtask('t-a', child())).rejects.toMatchObject({ status: 409 });
  });
});

describe('awaitTask', () => {
  async function parentAndChild(r: ReturnType<typeof createTestRelay>, over = {}) {
    await spawnedTask(r);
    r.orchestrator.respond('t-a', accept);
    const out = await r.orchestrator.proposeSubtask('t-a', sampleContract('t-a-schema', over));
    expect(out.status).toBe('proposed');
  }

  it('is pending with both states while the child executes, then resolves completed with the child branch', async () => {
    const r = createTestRelay();
    await parentAndChild(r);
    expect(await r.orchestrator.awaitTask('t-a-schema', 1)).toEqual({ status: 'pending', task_id: 't-a-schema', task_state: 'proposed', handoff_state: 'proposed' });
    r.orchestrator.respond('t-a-schema', accept);
    expect(await r.orchestrator.awaitTask('t-a-schema', 1)).toEqual({ status: 'pending', task_id: 't-a-schema', task_state: 'executing', handoff_state: 'accepted' });
    const poll = r.orchestrator.awaitTask('t-a-schema', 5);
    r.orchestrator.submitEvidence('t-a-schema', { contract_version: 1, claimed: claimedAll, summary: 'schema done' });
    expect(await poll).toEqual({ status: 'completed', task_id: 't-a-schema', branch: 'relay/t-a-schema' });
    await r.orchestrator.settled();
    // a completed task answers immediately afterwards too
    expect(await r.orchestrator.awaitTask('t-a-schema', 1)).toEqual({ status: 'completed', task_id: 't-a-schema', branch: 'relay/t-a-schema' });
  });

  it('a canceled child resolves canceled', async () => {
    const r = createTestRelay();
    await parentAndChild(r);
    const poll = r.orchestrator.awaitTask('t-a-schema', 5);
    await r.orchestrator.cancel('t-a-schema', 'not needed');
    expect(await poll).toEqual({ status: 'canceled', task_id: 't-a-schema' });
  });

  it('a child that exhausts its repair budget resolves failed with the budget reason', async () => {
    const r = createTestRelay({ script: { 'AC-2': 'failed' } });
    await parentAndChild(r, { budget: { max_repairs: 0, stagnation_limit: 2 } });
    r.orchestrator.respond('t-a-schema', accept);
    const poll = r.orchestrator.awaitTask('t-a-schema', 5);
    r.orchestrator.submitEvidence('t-a-schema', { contract_version: 1, claimed: claimedAll, summary: 's' });
    expect(await poll).toEqual({ status: 'failed', task_id: 't-a-schema', reason: expect.stringMatching(/repair budget exhausted/) });
  });

  it('any task may be awaited, but awaiting yourself is a 400 and unknown tasks are 404', async () => {
    const r = createTestRelay();
    await parentAndChild(r);
    expect((await r.orchestrator.awaitTask('t-a', 1, undefined, 't-a-schema')).status).toBe('pending');
    await expect(r.orchestrator.awaitTask('t-a', 1, undefined, 't-a')).rejects.toMatchObject({ status: 400 });
    await expect(r.orchestrator.awaitTask('t-nope', 1)).rejects.toMatchObject({ status: 404 });
  });

  it('stops early when the caller aborts', async () => {
    const r = createTestRelay();
    await parentAndChild(r);
    const ac = new AbortController();
    const poll = r.orchestrator.awaitTask('t-a-schema', 30, ac.signal);
    setTimeout(() => ac.abort(), 10);
    expect(await poll).toMatchObject({ status: 'pending' });
  });
});

describe('accept guard', () => {
  const full = { 'AC-1': 'run the tests', 'AC-2': 'diff stays in scope' };

  it('accept with an empty interpretation is invalid, names interpretation, and emits nothing', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    const out = r.orchestrator.respond('t-a', { ...accept, interpretation: ['', '  '], verification_plan: full });
    expect(out.status).toBe('invalid');
    if (out.status !== 'invalid') throw new Error();
    expect(out.errors.join('\n')).toMatch(/interpretation/);
    expect(r.types()).not.toContain('task_accepted');
    expect(r.orchestrator.taskView('t-a')).toMatchObject({ task_state: 'proposed', handoff_state: 'proposed' });
  });

  it('accept with a plan missing AC-2 is invalid and names AC-2; unknown plan ids are named too', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    const missing = r.orchestrator.respond('t-a', { ...accept, verification_plan: { 'AC-1': 'run', 'AC-2': '   ' } });
    expect(missing.status).toBe('invalid');
    if (missing.status !== 'invalid') throw new Error();
    expect(missing.errors.join('\n')).toMatch(/AC-2/);
    expect(missing.errors.join('\n')).not.toMatch(/AC-1/);
    const unknown = r.orchestrator.respond('t-a', { ...accept, verification_plan: { ...full, 'AC-9': 'nope' } });
    expect(unknown.status).toBe('invalid');
    if (unknown.status !== 'invalid') throw new Error();
    expect(unknown.errors.join('\n')).toMatch(/AC-9/);
    expect(r.types()).not.toContain('task_accepted');
  });

  it('after an invalid accept the agent can respond again; a full plan starts work', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    expect(r.orchestrator.respond('t-a', { ...accept, interpretation: [] }).status).toBe('invalid');
    const ok = r.orchestrator.respond('t-a', { ...accept, verification_plan: full });
    expect(ok).toMatchObject({ status: 'work_started', worktree: { path: '/tmp/fake/t-a' } });
    expect(r.types().filter((t) => t === 'task_accepted' || t === 'work_started')).toEqual(['task_accepted', 'work_started']);
    expect(r.orchestrator.taskView('t-a')!.task_state).toBe('executing');
  });

  it('needs_clarification requires at least one question and rejected requires a reason', async () => {
    const r = createTestRelay();
    await spawnedTask(r);
    const noQuestions = r.orchestrator.respond('t-a', { ...accept, decision: 'needs_clarification', questions: [] });
    expect(noQuestions.status).toBe('invalid');
    if (noQuestions.status !== 'invalid') throw new Error();
    expect(noQuestions.errors.join('\n')).toMatch(/question/);
    const noReason = r.orchestrator.respond('t-a', { ...accept, decision: 'rejected', reason: '  ' });
    expect(noReason.status).toBe('invalid');
    if (noReason.status !== 'invalid') throw new Error();
    expect(noReason.errors.join('\n')).toMatch(/reason/);
    expect(r.types()).not.toContain('clarification_requested');
    expect(r.types()).not.toContain('task_rejected');
    expect(r.orchestrator.respond('t-a', { ...accept, decision: 'rejected', reason: 'out of scope' })).toEqual({ status: 'rejected' });
  });
});
