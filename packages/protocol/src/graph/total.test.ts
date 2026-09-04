/**
 * Totality: every graph function must accept any valid State without throwing, including states built
 * from the reducer's "every event type" sequence and from failure paths no live fixture records yet.
 */
import { describe, it, expect } from 'vitest';
import { actionsFor, buildGraph, describe as describeObject, storyFor } from './index.js';
import { replay } from '../reducer.js';
import { EventLog, contract, MISSION_ID } from '../testkit.test.js';
import type { RepairContract } from '../contract.js';

const BACKEND = 't-backend-auth';

const repair = (n: number): RepairContract => ({
  id: `${BACKEND}/r${n}`,
  parent_task: BACKEND,
  parent_version: 1,
  attempt: n + 1,
  failed_criteria: ['AC-1'],
  observed_failure: 'expected 401, received 200',
  requested_correction: 'Reject expired tokens',
  unchanged_scope: [],
  remaining_repairs: 3 - n,
});

function escalatedLog() {
  const log = new EventLog();
  log.add('mission_created', { id: MISSION_ID, repo: '/workspace/demo', title: 'Add secure login' }, { actor: 'human' });
  log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
  log.add('worktree_created', { path: '/wt/backend', branch: 'relay/t-backend-auth', base: 'main' }, { task_id: BACKEND });
  log.add('agent_spawned', { runtime: 'claude-code', pane_id: '%1', session_id: 's1', cwd: '/wt/backend' }, { task_id: BACKEND });
  log.add('task_accepted', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'accepted' } }, { task_id: BACKEND, actor: 'agent:backend' });
  log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
  log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: { 'AC-1': { status: 'passed' } } } }, { task_id: BACKEND, actor: 'agent:backend' });
  log.add('evidence_recorded', { record: { task_id: BACKEND, contract_version: 1, attempt: 1, changed_files: [], checks: { 'AC-1': { status: 'failed', observed: '200' }, 'AC-2': { status: 'passed' } }, self_report_mismatch: ['AC-1'] } }, { task_id: BACKEND });
  log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
  log.add('repair_accepted', { repair_id: repair(1).id }, { task_id: BACKEND, actor: 'agent:backend' });
  log.add('task_escalated', { reason: 'stagnation on AC-1', failed_criteria: ['AC-1'] }, { task_id: BACKEND });
  return log;
}

describe('graph totality', () => {
  it('an escalated task is failed on the graph and raises an escalation inbox item that can still be canceled', () => {
    const log = escalatedLog();
    const state = replay(log.events);
    const g = buildGraph(state);
    expect(g.nodes.find((n) => n.id === BACKEND)!.status).toBe('failed');
    expect(g.edges.find((e) => e.id === `evidence:${BACKEND}`)).toMatchObject({ label: 'escalated', status: 'failed' });
    expect(g.inbox.map((i) => i.kind)).toEqual(['escalation']);
    const item = g.inbox[0]!;
    expect(item.title).toBe("backend's t-backend-auth is escalated");
    expect(item.detail).toEqual(['escalated: needs a planner or human decision', 'AC-1: expected 401, received 200']);
    expect(item.actions.map((a) => a.kind)).toEqual(['focus', 'inspect', 'cancel']);
    expect(describeObject({ kind: 'node', id: BACKEND }, g, state).lines).toContain('escalated: needs a planner or human decision');
  });

  it('a task that exhausted its budget is failed with a budget escalation item; a canceled task raises nothing', () => {
    const log = escalatedLog();
    log.add('task_failed_budget', { attempts: 4, reason: 'max repairs exhausted' }, { task_id: BACKEND });
    const failed = replay(log.events);
    const gf = buildGraph(failed);
    expect(gf.nodes.find((n) => n.id === BACKEND)!.status).toBe('failed');
    expect(gf.edges.find((e) => e.id === `evidence:${BACKEND}`)).toMatchObject({ label: '✗', status: 'failed' });
    expect(gf.inbox[0]).toMatchObject({ kind: 'escalation', title: 'backend failed t-backend-auth (budget exhausted)' });
    expect(gf.inbox[0]!.detail[0]).toBe('failed after 1 attempt');

    log.add('task_canceled', { reason: 'bye' }, { task_id: BACKEND, actor: 'human' });
    const canceled = replay(log.events);
    const gc = buildGraph(canceled);
    expect(gc.edges.find((e) => e.id === `evidence:${BACKEND}`)).toMatchObject({ label: 'canceled', status: 'failed' });
    expect(actionsFor({ kind: 'node', id: BACKEND }, gc, canceled).map((a) => a.kind)).toEqual(['focus', 'inspect']);
  });

  it('a rejected contract is a failed edge with v1 ✗', () => {
    const log = new EventLog();
    log.add('mission_created', { id: MISSION_ID, repo: '/r', title: 'T' }, { actor: 'human' });
    log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
    log.add('task_rejected', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'rejected', reason: 'no' } }, { task_id: BACKEND, actor: 'agent:backend' });
    const state = replay(log.events);
    const g = buildGraph(state);
    expect(g.edges.find((e) => e.id === `contract:${BACKEND}`)).toMatchObject({ label: 'v1 ✗', status: 'failed' });
    expect(g.nodes.find((n) => n.id === BACKEND)!.status).toBe('failed');
  });

  it('every function survives the reducer test\'s every-event-type sequence and every ref it produces', () => {
    const log = escalatedLog();
    log.add('tasks_planned', { task_ids: [BACKEND] }, { actor: 'planner' });
    log.add('lint_reported', { contract_version: 1, results: [{ rule: 'missing_input', severity: 'error', message: 'x', task_id: BACKEND }] }, { task_id: BACKEND });
    log.add('clarification_requested', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'needs_clarification', questions: [{ id: 'Q1', text: 'Expiry?' }] } }, { task_id: BACKEND, actor: 'agent:backend' });
    log.add('task_blocked', { reason: 'waiting on schema', waiting_on: 't-auth-schema' }, { task_id: BACKEND, actor: 'agent:backend' });
    log.add('blocker_replied', { message: 'see branch' }, { task_id: BACKEND, actor: 'human' });
    log.add('mission_clarification_requested', { questions: [{ id: 'Q1', text: 'Which mechanism?', blocking: true }] }, { actor: 'planner' });
    log.add('integration_started', { branch: 'relay/integration', order: [BACKEND] });
    log.add('integration_conflict', { task_id: BACKEND, files: ['src/auth/token.ts'] });
    log.add('mission_failed', { reason: 'boom' });
    let state = replay([]);
    for (const e of log.events) {
      state = replay([e], state);
      const g = buildGraph(state);
      const refs = [
        ...g.nodes.map((n) => ({ kind: 'node' as const, id: n.id })),
        ...g.edges.map((n) => ({ kind: 'edge' as const, id: n.id })),
        ...g.inbox.map((n) => ({ kind: 'inbox' as const, id: n.id })),
      ];
      for (const ref of refs) {
        expect(() => actionsFor(ref, g, state), `${e.type} ${ref.id}`).not.toThrow();
        expect(() => storyFor(ref, g, state, log.events), `${e.type} ${ref.id}`).not.toThrow();
        const d = describeObject(ref, g, state);
        expect(d.title.length, `${e.type} ${ref.id}`).toBeGreaterThan(0);
      }
    }
    const g = buildGraph(state);
    expect(g.inbox.map((i) => i.kind).sort()).toEqual(['blocker', 'escalation', 'mission_question', 'task_question']);
    expect(g.nodes.find((n) => n.id === 'planner')!.status).toBe('attention');
  });
});
