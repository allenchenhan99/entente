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
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-b', { dependencies: ['t-a'] }), 'planner');
    expect(r.host.calls.spawn).toHaveLength(0);
    await r.orchestrator.proposeTask(mission_id, sampleContract('t-a'), 'planner');
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
