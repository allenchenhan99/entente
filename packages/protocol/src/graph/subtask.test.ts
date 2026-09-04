/**
 * Agent networking in the graph object model: a task with `parent_task` set is a subtask; its contract
 * edge comes from its parent agent, it sits below its parent in the agent column, and the parent's
 * description and story include it. States without subtasks are covered by the fixture-based tests.
 */
import { describe, it, expect } from 'vitest';
import { buildGraph, describe as describeObject, storyFor } from './index.js';
import { Event } from '../events.js';
import { TaskContract } from '../contract.js';
import { replay } from '../reducer.js';

const MISSION = 'm-sub001';
const PARENT = 't-backend';
const CHILD = 't-api-schema'; // sorts before its parent by id on purpose
const SIBLING = 't-frontend';

function contract(id: string, recipient: string, sender: string, over: Partial<TaskContract> = {}): TaskContract {
  return TaskContract.parse({
    id, mission_id: MISSION, version: 1, sender, recipient, runtime: 'claude-code', goal: `Implement ${id}`,
    scope: { allowed_paths: [`src/${id}/**`] },
    acceptance_criteria: [{ id: 'AC-1', condition: 'tests pass', check: { kind: 'command', run: 'npx vitest run' } }],
    ...over,
  });
}

const response = (taskId: string) => ({ task_id: taskId, contract_version: 1, decision: 'accepted' as const, interpretation: ['ok'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'run' }, questions: [] });

/** Builds a valid event log from `[actor, type, task_id?, payload]` rows. */
function log(rows: Array<[string, string, string | undefined, unknown]>): Event[] {
  return rows.map(([actor, type, task_id, payload], i) =>
    Event.parse({ seq: i + 1, ts: `2026-09-04T10:${String(i).padStart(2, '0')}:00.000Z`, mission_id: MISSION, ...(task_id ? { task_id } : {}), actor, type, payload }));
}

const propose = (c: TaskContract, actor: string = c.sender): Array<[string, string, string | undefined, unknown]> => [
  [actor, 'task_proposed', c.id, { contract: c }],
  ['relayd', 'lint_reported', c.id, { contract_version: 1, results: [] }],
  ['relayd', 'worktree_created', c.id, { path: `/wt/${c.id}`, branch: `relay/${c.id}`, base: 'main' }],
  ['relayd', 'agent_spawned', c.id, { runtime: 'claude-code', pane_id: `%${c.id}`, session_id: 's', cwd: `/wt/${c.id}` }],
];
const accept = (c: TaskContract): Array<[string, string, string | undefined, unknown]> => [
  [`agent:${c.recipient}`, 'task_accepted', c.id, { contract_version: 1, response: response(c.id) }],
  [`agent:${c.recipient}`, 'work_started', c.id, {}],
];
const verify = (c: TaskContract): Array<[string, string, string | undefined, unknown]> => [
  [`agent:${c.recipient}`, 'evidence_submitted', c.id, { submission: { task_id: c.id, contract_version: 1, attempt: 1, claimed: { 'AC-1': { status: 'passed' } }, summary: 'done' } }],
  ['relayd', 'task_verified', c.id, { attempt: 1 }],
  ['relayd', 'task_completed', c.id, {}],
];

const parent = contract(PARENT, 'backend', 'planner');
const sibling = contract(SIBLING, 'frontend', 'planner');
const child = contract(CHILD, 'schema', 'agent:backend', { parent_task: PARENT });

const mission: [string, string, string | undefined, unknown] = ['human', 'mission_created', undefined, { id: MISSION, repo: '/repo', title: 'Add login' }];

describe('graph with subtasks', () => {
  const proposedOnly = log([mission, ...propose(parent), ...accept(parent), ...propose(sibling), ...propose(child)]);
  const childAccepted = log([mission, ...propose(parent), ...accept(parent), ...propose(sibling), ...propose(child), ...accept(child)]);
  const childVerified = log([mission, ...propose(parent), ...accept(parent), ...propose(sibling), ...propose(child), ...accept(child), ...verify(child)]);

  it('the delegation edge shows the await_task outcome from the parent: waiting, then merged', () => {
    const early = buildGraph(replay(proposedOnly));
    expect(early.edges.find((e) => e.id === `contract:${CHILD}`)).toMatchObject({ kind: 'contract', from: PARENT, to: CHILD, task_id: CHILD, label: 'sub v1', status: 'pending', version: 1 });
    expect(early.edges.find((e) => e.id === `contract:${PARENT}`)).toMatchObject({ from: 'planner', to: PARENT, label: 'v1 ✓' });
    const g = buildGraph(replay(childAccepted));
    expect(g.edges.find((e) => e.id === `contract:${CHILD}`)).toMatchObject({ from: PARENT, to: CHILD, label: 'sub ⏳ v1', status: 'working', attention: false });
    const done = buildGraph(replay(childVerified));
    expect(done.edges.find((e) => e.id === `contract:${CHILD}`)).toMatchObject({ from: PARENT, label: 'sub ✓ merged', status: 'verified', attention: false });
    expect(done.edges.find((e) => e.id === `evidence:${CHILD}`)).toMatchObject({ from: CHILD, to: 'verifier', label: '✓' });
  });

  it('the delegation edge demands attention when the merge conflicted or the subtask failed / was canceled', () => {
    const conflictLog = log([mission, ...propose(parent), ...accept(parent), ...propose(sibling), ...propose(child), ...accept(child), ...verify(child),
      ['relayd', 'task_blocked', PARENT, { reason: `subtask ${CHILD} could not be merged into your worktree: conflicts in src/x.ts`, waiting_on: 'human' }]]);
    const conflict = buildGraph(replay(conflictLog));
    expect(conflict.edges.find((e) => e.id === `contract:${CHILD}`)).toMatchObject({ label: 'sub ✗ conflict', status: 'attention', attention: true });

    const canceledLog = log([mission, ...propose(parent), ...accept(parent), ...propose(child), ...accept(child), ['human', 'task_canceled', CHILD, { reason: 'out of scope' }]]);
    const canceled = buildGraph(replay(canceledLog));
    expect(canceled.edges.find((e) => e.id === `contract:${CHILD}`)).toMatchObject({ label: 'sub ✗ canceled', status: 'failed', attention: true });
  });

  it('places the subtask in the agent column right after its parent, ahead of later siblings', () => {
    const g = buildGraph(replay(childAccepted));
    expect(g.nodes.map((n) => n.id)).toEqual(['human', 'planner', PARENT, CHILD, SIBLING, 'verifier']);
    expect(g.nodes.find((n) => n.id === CHILD)).toMatchObject({ kind: 'agent', label: 'schema', column: 1, status: 'working' });
  });

  it('orders several subtasks of one parent by dependency depth then id', () => {
    const a = contract('t-zz-a', 'za', 'agent:backend', { parent_task: PARENT });
    const b = contract('t-aa-b', 'ab', 'agent:backend', { parent_task: PARENT, dependencies: ['t-zz-a'] });
    const events = log([mission, ...propose(parent), ...accept(parent), ...propose(b), ...propose(a)]);
    const g = buildGraph(replay(events));
    expect(g.nodes.map((n) => n.id)).toEqual(['human', 'planner', PARENT, 't-zz-a', 't-aa-b', 'verifier']);
    expect(g.edges.find((e) => e.id === 'dep:t-zz-a->t-aa-b')).toMatchObject({ kind: 'dependency', from: 't-zz-a', to: 't-aa-b' });
  });

  it('contract edges come from the sender node: human → human, a role without parent_task → that role\'s agent, unknown → planner', () => {
    const byHuman = contract('t-by-human', 'human-task', 'human');
    const byRole = contract('t-by-role', 'delegate', 'backend');
    const byGhost = contract('t-by-ghost', 'ghost', 'agent:nobody');
    const g = buildGraph(replay(log([mission, ...propose(parent), ...propose(byHuman), ...propose(byRole, 'agent:backend'), ...propose(byGhost)])));
    expect(g.edges.find((e) => e.id === 'contract:t-by-human')!.from).toBe('human');
    expect(g.edges.find((e) => e.id === 'contract:t-by-role')!.from).toBe(PARENT);
    expect(g.edges.find((e) => e.id === 'contract:t-by-ghost')!.from).toBe('planner');
    expect(g.edges.find((e) => e.id === 'contract:t-by-role')!.label).toBe('v1');
  });

  it('describe(parent) lists its subtasks and describe(child) names its parent', () => {
    const state = replay(childAccepted);
    const g = buildGraph(state);
    const p = describeObject({ kind: 'node', id: PARENT }, g, state);
    expect(p.lines).toContain(`subtasks: ${CHILD}`);
    const c = describeObject({ kind: 'node', id: CHILD }, g, state);
    expect(c.lines).toContain(`parent: ${PARENT}`);
    expect(c.lines).not.toContainEqual(expect.stringMatching(/^subtasks:/));
    const s = describeObject({ kind: 'node', id: SIBLING }, g, state);
    expect(s.lines).not.toContainEqual(expect.stringMatching(/^subtasks:|^parent:/));
  });

  it('storyFor(parent) includes the subtask\'s proposal and verification lines, in seq order', () => {
    const state = replay(childVerified);
    const g = buildGraph(state);
    const story = storyFor({ kind: 'node', id: PARENT }, g, state, childVerified);
    expect(story.some((l) => new RegExp(`backend proposes ${CHILD} v1 to schema`).test(l))).toBe(true);
    expect(story.some((l) => /RelayGraph verifies schema/.test(l))).toBe(true);
    expect(story.some((l) => /schema accepts|schema submits|schema completes/.test(l))).toBe(false);
    const prefixes = story.map((l) => l.slice(0, 5));
    expect(prefixes).toEqual([...prefixes].sort());
    // the sibling's story is unaffected
    expect(storyFor({ kind: 'node', id: SIBLING }, g, state, childVerified).some((l) => /schema/.test(l))).toBe(false);
  });
});
