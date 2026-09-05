import { describe, it, expect } from 'vitest';
import { reduce, replay } from './reducer.js';
import { initialState, type State } from './state.js';
import { EVENT_TYPES, Event, type EventType } from './events.js';
import { EventLog, contract, MISSION_ID } from './testkit.test.js';
import type { EvidenceRecord, RepairContract } from './contract.js';

const BACKEND = 't-backend-auth';
const FRONTEND = 't-frontend-login';
const E2E = 't-e2e-tests';

const mission = () => ({ id: MISSION_ID, repo: '/workspace/demo', title: 'Add secure login', success_definition: 'all verified' });

const record = (attempt: number, mismatch: string[] = []): EvidenceRecord => ({
  task_id: BACKEND,
  contract_version: 1,
  attempt,
  changed_files: ['src/auth/token.ts'],
  checks: { 'AC-1': { status: mismatch.length ? 'failed' : 'passed' }, 'AC-2': { status: 'passed' } },
  self_report_mismatch: mismatch,
});

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

/** Mission + one proposed, spawned backend task. */
function proposedBackend(log = new EventLog()) {
  log.add('mission_created', mission(), { actor: 'human' });
  log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
  return log;
}

function acceptedBackend(log = proposedBackend()) {
  log.add('worktree_created', { path: '/wt/backend', branch: 'relay/t-backend-auth', base: 'main' }, { task_id: BACKEND });
  log.add('agent_spawned', { runtime: 'claude-code', pane_id: '%1', session_id: 's1', cwd: '/wt/backend' }, { task_id: BACKEND });
  log.add('task_accepted', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'accepted' } }, { task_id: BACKEND, actor: 'agent:backend' });
  return log;
}

describe('reducer', () => {
  describe('every event type', () => {
    it('handles every event type in a realistic sequence without throwing and updates last_seq', () => {
      const log = acceptedBackend();
      log.add('tasks_planned', { task_ids: [BACKEND] }, { actor: 'planner' });
      log.add('lint_reported', { contract_version: 1, results: [] }, { task_id: BACKEND });
      log.add('clarification_requested', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'needs_clarification', questions: [{ id: 'Q1', text: 'Expiry?' }] } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('clarification_answered', { answers: [{ question_id: 'Q1', answer: '15 minutes', answered_by: 'human', at: '2026-09-05T10:05:00+08:00' }] }, { task_id: BACKEND, actor: 'human' });
      log.add('contract_revised', { contract: contract({ version: 2 }), previous_version: 1 }, { task_id: BACKEND });
      log.add('task_rejected', { contract_version: 2, response: { task_id: BACKEND, contract_version: 2, decision: 'rejected', reason: 'no' } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('progress_reported', { message: 'half way', percent: 50 }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('task_blocked', { reason: 'waiting on schema', waiting_on: 't-auth-schema' }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('blocker_replied', { message: 'schema is on branch relay/t-auth-schema' }, { task_id: BACKEND, actor: 'human' });
      log.add('task_unblocked', {}, { task_id: BACKEND, actor: 'human' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: { 'AC-1': { status: 'passed' } } } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('checks_started', { attempt: 1 }, { task_id: BACKEND });
      log.add('check_passed', { attempt: 1, criterion_id: 'AC-2', result: { status: 'passed' } }, { task_id: BACKEND });
      log.add('check_failed', { attempt: 1, criterion_id: 'AC-1', result: { status: 'failed', observed: '200' } }, { task_id: BACKEND });
      log.add('human_review_recorded', { attempt: 1, criterion_id: 'AC-1', status: 'failed', observed_failure: 'nope' }, { task_id: BACKEND, actor: 'human' });
      log.add('evidence_recorded', { record: record(1, ['AC-1']) }, { task_id: BACKEND });
      log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
      log.add('repair_accepted', { repair_id: repair(1).id }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('task_escalated', { reason: 'stagnation', failed_criteria: ['AC-1'] }, { task_id: BACKEND });
      log.add('task_verified', { attempt: 2 }, { task_id: BACKEND });
      log.add('task_completed', {}, { task_id: BACKEND });
      log.add('task_failed_budget', { attempts: 4, reason: 'budget' }, { task_id: BACKEND });
      log.add('task_canceled', { reason: 'bye' }, { task_id: BACKEND, actor: 'human' });
      log.add('agent_exited', { pane_id: '%1', exit_reason: 'done' }, { task_id: BACKEND });
      log.add('integration_started', { branch: 'relay/integration', order: [BACKEND] });
      log.add('integration_conflict', { task_id: BACKEND, files: ['src/auth/token.ts'] });
      log.add('mission_clarification_requested', { questions: [{ id: 'Q1', text: 'Which mechanism?', blocking: true }] }, { actor: 'planner' });
      log.add('mission_clarification_answered', { answers: [{ question_id: 'Q1', answer: 'magic link', answered_by: 'human', at: '2026-09-05T10:06:00+08:00' }] }, { actor: 'human' });
      log.add('mission_verified', {}, { actor: 'human' });
      log.add('mission_failed', { reason: 'boom' });
      log.add('mission_canceled', { reason: 'changed my mind' });
      log.add('task_deleted', { reason: 'tidying up' }, { task_id: BACKEND });
      log.add('mission_deleted', { reason: 'abandoned' });

      const seen = new Set<EventType>(log.events.map((e) => e.type));
      expect([...EVENT_TYPES].filter((t) => !seen.has(t))).toEqual([]);
      expect(EVENT_TYPES).toHaveLength(39);

      let state = initialState();
      for (const e of log.events) {
        expect(() => (state = reduce(state, e))).not.toThrow();
        expect(state.last_seq).toBe(e.seq);
      }
    });

    it('handles every event type applied alone to the initial state (unknown task/mission) without throwing', () => {
      const log = new EventLog();
      const payloads: { [T in EventType]: Extract<Event, { type: T }>['payload'] } = {
        mission_created: mission(),
        tasks_planned: { task_ids: [BACKEND] },
        lint_reported: { contract_version: 1, results: [] },
        task_proposed: { contract: contract() },
        clarification_requested: { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'needs_clarification', interpretation: [], assumptions: [], risks: [], verification_plan: {}, questions: [] } },
        clarification_answered: { answers: [] },
        contract_revised: { contract: contract({ version: 2 }), previous_version: 1 },
        task_accepted: { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'accepted', interpretation: [], assumptions: [], risks: [], verification_plan: {}, questions: [] } },
        task_rejected: { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'rejected', interpretation: [], assumptions: [], risks: [], verification_plan: {}, questions: [] } },
        worktree_created: { path: '/wt', branch: 'b', base: 'main' },
        agent_spawned: { runtime: 'codex', pane_id: '%1', session_id: 's', cwd: '/wt' },
        agent_exited: { pane_id: '%1' },
        work_started: {},
        progress_reported: { message: 'm' },
        task_blocked: { reason: 'r' },
        task_unblocked: {},
        evidence_submitted: { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {}, summary: '' } },
        checks_started: { attempt: 1 },
        check_passed: { attempt: 1, criterion_id: 'AC-1', result: { status: 'passed' } },
        check_failed: { attempt: 1, criterion_id: 'AC-1', result: { status: 'failed' } },
        human_review_recorded: { attempt: 1, criterion_id: 'AC-1', status: 'passed' },
        evidence_recorded: { record: record(1) },
        repair_requested: { repair: repair(1) },
        repair_accepted: { repair_id: 'r1' },
        task_verified: { attempt: 1 },
        task_completed: {},
        task_failed_budget: { attempts: 1, reason: 'r' },
        task_escalated: { reason: 'r', failed_criteria: ['AC-1'] },
        task_canceled: {},
        integration_started: { branch: 'b', order: [] },
        integration_conflict: { task_id: BACKEND, files: [] },
        mission_verified: {},
        mission_failed: { reason: 'r' },
        mission_canceled: { reason: 'r' },
        task_deleted: { reason: 'r' },
        mission_deleted: { reason: 'r' },
        blocker_replied: { message: 'use the fake sender' },
        mission_clarification_requested: { questions: [{ id: 'Q1', text: 'Which mechanism?', blocking: true }] },
        mission_clarification_answered: { answers: [{ question_id: 'Q1', answer: 'magic link', answered_by: 'human', at: 'x' }] },
      };
      for (const type of EVENT_TYPES) {
        const e = log.add(type, payloads[type] as never, { task_id: BACKEND });
        const s = reduce(initialState(), { ...e, seq: 1 });
        expect(s.last_seq).toBe(1);
      }
    });
  });

  describe('purity and idempotence', () => {
    it('ignores events with seq <= last_seq and returns the same state object', () => {
      const log = proposedBackend();
      const s1 = replay(log.events);
      expect(reduce(s1, log.events[0]!)).toBe(s1);
      expect(reduce(s1, { ...log.events[1]!, seq: s1.last_seq })).toBe(s1);
    });

    it('does not mutate the input state', () => {
      const log = acceptedBackend();
      const before = replay(log.events.slice(0, 2));
      const snapshot = JSON.parse(JSON.stringify(before));
      replay(log.events.slice(2), before);
      expect(before).toEqual(snapshot);
    });

    it('replay from a partial state continues from last_seq', () => {
      const log = acceptedBackend();
      const partial = replay(log.events.slice(0, 3));
      const full = replay(log.events, partial);
      expect(full).toEqual(replay(log.events));
    });
  });

  describe('three layers', () => {
    it('blocker_replied appends a reply (actor, message, time) and leaves the blocker in place', () => {
      const log = acceptedBackend();
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('task_blocked', { reason: 'need creds', waiting_on: 'human' }, { task_id: BACKEND, actor: 'agent:backend' });
      const replied = log.add('blocker_replied', { message: 'creds are in .env.example' }, { task_id: BACKEND, actor: 'human' });
      const t = replay(log.events).tasks[BACKEND]!;
      expect(t.runtime).toBe('blocked');
      expect(t.replies).toEqual([{ message: 'creds are in .env.example', replied_by: 'human', at: replied.ts }]);
    });

    it('runtime is blocked while task_state is executing and handoff_state is accepted', () => {
      const log = acceptedBackend();
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('task_blocked', { reason: 'waiting on schema', waiting_on: 't-auth-schema' }, { task_id: BACKEND, actor: 'agent:backend' });
      const t = replay(log.events).tasks[BACKEND]!;
      expect(t.runtime).toBe('blocked');
      expect(t.task_state).toBe('executing');
      expect(t.handoff_state).toBe('accepted');
      expect(t.blocker).toEqual({ reason: 'waiting on schema', waiting_on: 't-auth-schema', since: log.events.at(-1)!.ts });
    });
  });

  describe('handoff_state', () => {
    it('starts at proposed after task_proposed with proposed_at and one version', () => {
      const log = proposedBackend();
      const t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('proposed');
      expect(t.task_state).toBe('proposed');
      expect(t.runtime).toBe('unspawned');
      expect(t.versions).toHaveLength(1);
      expect(t.proposed_at).toBe(log.events[1]!.ts);
      expect(t.blocked_on_dependencies).toEqual([]);
      expect(t.attempt).toBe(0);
      expect(t.escalated).toBe(false);
    });

    it('clarification cycle: needs_clarification → revised → proposed (v2) with versions appended', () => {
      const log = proposedBackend();
      log.add('clarification_requested', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'needs_clarification', questions: [{ id: 'Q1', text: 'Expiry?' }, { id: 'Q2', text: 'Method?' }] } }, { task_id: BACKEND, actor: 'agent:backend' });
      let t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('needs_clarification');
      expect(t.open_questions.map((q) => q.id)).toEqual(['Q1', 'Q2']);
      expect(t.response?.decision).toBe('needs_clarification');

      log.add('clarification_answered', { answers: [{ question_id: 'Q1', answer: '15 min', answered_by: 'human', at: 'x' }] }, { task_id: BACKEND, actor: 'human' });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('revised');
      expect(t.open_questions.map((q) => q.id)).toEqual(['Q2']);

      const v2 = contract({ version: 2, clarifications: [{ question_id: 'Q1', answer: '15 min', answered_by: 'human', at: 'x' }] });
      const revised = log.add('contract_revised', { contract: v2, previous_version: 1 }, { task_id: BACKEND });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('proposed');
      expect(t.contract.version).toBe(2);
      expect(t.versions.map((v) => v.version)).toEqual([1, 2]);
      expect(t.proposed_at).toBe(revised.ts);
    });

    it('task_accepted → accepted with accepted_at and response', () => {
      const log = acceptedBackend();
      const t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('accepted');
      expect(t.task_state).toBe('accepted');
      expect(t.accepted_at).toBe(log.events.at(-1)!.ts);
      expect(t.response?.decision).toBe('accepted');
    });

    it('task_rejected → rejected', () => {
      const log = proposedBackend();
      log.add('task_rejected', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'rejected', reason: 'out of scope' } }, { task_id: BACKEND, actor: 'agent:backend' });
      expect(replay(log.events).tasks[BACKEND]!.handoff_state).toBe('rejected');
    });

    it('evidence → retry_requested → accepted → evidence → verified', () => {
      const log = acceptedBackend();
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      let t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('evidence_submitted');
      log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('retry_requested');
      log.add('repair_accepted', { repair_id: repair(1).id }, { task_id: BACKEND, actor: 'agent:backend' });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('accepted');
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 2, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('task_verified', { attempt: 2 }, { task_id: BACKEND });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.handoff_state).toBe('verified');
    });
  });

  describe('task_state', () => {
    it('follows accepted → executing → awaiting_verification → repairing → completed', () => {
      const log = acceptedBackend();
      const started = log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      let t = replay(log.events).tasks[BACKEND]!;
      expect(t.task_state).toBe('executing');
      expect(t.started_at).toBe(started.ts);
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.task_state).toBe('awaiting_verification');
      log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
      log.add('repair_accepted', { repair_id: repair(1).id }, { task_id: BACKEND, actor: 'agent:backend' });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.task_state).toBe('repairing');
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 2, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('task_verified', { attempt: 2 }, { task_id: BACKEND });
      const completed = log.add('task_completed', {}, { task_id: BACKEND });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.task_state).toBe('completed');
      expect(t.completed_at).toBe(completed.ts);
    });

    it('task_failed_budget → failed, task_canceled → canceled', () => {
      const a = acceptedBackend();
      a.add('task_failed_budget', { attempts: 4, reason: 'over budget' }, { task_id: BACKEND });
      expect(replay(a.events).tasks[BACKEND]!.task_state).toBe('failed');
      const b = acceptedBackend();
      b.add('task_canceled', { reason: 'nope' }, { task_id: BACKEND, actor: 'human' });
      expect(replay(b.events).tasks[BACKEND]!.task_state).toBe('canceled');
    });

    it('task_escalated sets escalated and leaves task_state at awaiting_verification', () => {
      const log = acceptedBackend();
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('task_escalated', { reason: 'stagnation', failed_criteria: ['AC-1'] }, { task_id: BACKEND });
      const t = replay(log.events).tasks[BACKEND]!;
      expect(t.escalated).toBe(true);
      expect(t.task_state).toBe('awaiting_verification');
    });
  });

  describe('runtime', () => {
    it('unspawned → idle → working → blocked → working → done → exited; never unknown', () => {
      const log = proposedBackend();
      expect(replay(log.events).tasks[BACKEND]!.runtime).toBe('unspawned');
      log.add('agent_spawned', { runtime: 'claude-code', pane_id: '%1', session_id: 's1', cwd: '/wt' }, { task_id: BACKEND });
      let t = replay(log.events).tasks[BACKEND]!;
      expect(t.runtime).toBe('idle');
      expect(t.agent).toEqual({ runtime: 'claude-code', pane_id: '%1', session_id: 's1' });
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      expect(replay(log.events).tasks[BACKEND]!.runtime).toBe('working');
      log.add('task_blocked', { reason: 'r' }, { task_id: BACKEND, actor: 'agent:backend' });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.runtime).toBe('blocked');
      expect(t.blocker?.reason).toBe('r');
      log.add('task_unblocked', {}, { task_id: BACKEND, actor: 'human' });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.runtime).toBe('working');
      expect(t.blocker).toBeUndefined();
      const progress = log.add('progress_reported', { message: 'm' }, { task_id: BACKEND, actor: 'agent:backend' });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.runtime).toBe('working');
      expect(t.last_seen_at).toBe(progress.ts);
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      expect(replay(log.events).tasks[BACKEND]!.runtime).toBe('done');
      log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
      log.add('repair_accepted', { repair_id: repair(1).id }, { task_id: BACKEND, actor: 'agent:backend' });
      expect(replay(log.events).tasks[BACKEND]!.runtime).toBe('working');
      log.add('agent_exited', { pane_id: '%1' }, { task_id: BACKEND });
      expect(replay(log.events).tasks[BACKEND]!.runtime).toBe('exited');
    });

    it('records worktree on worktree_created', () => {
      const log = acceptedBackend();
      expect(replay(log.events).tasks[BACKEND]!.worktree).toEqual({ path: '/wt/backend', branch: 'relay/t-backend-auth' });
    });
  });

  describe('attempts and repairs', () => {
    it('tracks attempt, attempts, repairs and active_repair', () => {
      const log = acceptedBackend();
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_recorded', { record: record(1, ['AC-1']) }, { task_id: BACKEND });
      log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
      let t = replay(log.events).tasks[BACKEND]!;
      expect(t.attempt).toBe(1);
      expect(t.attempts).toHaveLength(1);
      expect(t.repairs).toHaveLength(1);
      expect(t.active_repair?.id).toBe(`${BACKEND}/r1`);
      log.add('repair_accepted', { repair_id: repair(1).id }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 2, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_recorded', { record: record(2) }, { task_id: BACKEND });
      log.add('task_verified', { attempt: 2 }, { task_id: BACKEND });
      t = replay(log.events).tasks[BACKEND]!;
      expect(t.attempt).toBe(2);
      expect(t.attempts.map((a) => a.attempt)).toEqual([1, 2]);
      expect(t.active_repair).toBeUndefined();
      expect(t.repairs).toHaveLength(1);
    });
  });

  describe('dependencies', () => {
    it('blocked_on_dependencies lists incomplete dependencies and clears when they complete', () => {
      const log = acceptedBackend();
      log.add('task_proposed', { contract: contract({ id: E2E, recipient: 'e2e', dependencies: [BACKEND, FRONTEND] }) }, { task_id: E2E, actor: 'planner' });
      log.add('task_proposed', { contract: contract({ id: FRONTEND, recipient: 'frontend', runtime: 'codex' }) }, { task_id: FRONTEND, actor: 'planner' });
      expect(replay(log.events).tasks[E2E]!.blocked_on_dependencies).toEqual([BACKEND, FRONTEND]);
      log.add('task_completed', {}, { task_id: BACKEND });
      expect(replay(log.events).tasks[E2E]!.blocked_on_dependencies).toEqual([FRONTEND]);
      log.add('task_completed', {}, { task_id: FRONTEND });
      expect(replay(log.events).tasks[E2E]!.blocked_on_dependencies).toEqual([]);
    });
  });

  describe('lint', () => {
    it('stores latest lint_reported results and counts contracts blocked before execution once per task', () => {
      const log = proposedBackend();
      const err = { rule: 'missing_goal' as const, severity: 'error' as const, message: 'goal too short', task_id: BACKEND, field: 'goal' };
      log.add('lint_reported', { contract_version: 1, results: [err] }, { task_id: BACKEND });
      let s = replay(log.events);
      expect(s.tasks[BACKEND]!.lint).toEqual([err]);
      expect(s.metrics.contracts_blocked_before_execution).toBe(1);
      log.add('lint_reported', { contract_version: 1, results: [err, { ...err, rule: 'no_non_goals', severity: 'warning' }] }, { task_id: BACKEND });
      s = replay(log.events);
      expect(s.tasks[BACKEND]!.lint).toHaveLength(2);
      expect(s.metrics.contracts_blocked_before_execution).toBe(1);
      log.add('contract_revised', { contract: contract({ version: 2 }), previous_version: 1 }, { task_id: BACKEND });
      log.add('lint_reported', { contract_version: 2, results: [] }, { task_id: BACKEND });
      s = replay(log.events);
      expect(s.tasks[BACKEND]!.lint).toEqual([]);
      expect(s.metrics.contracts_blocked_before_execution).toBe(1);
      log.add('task_proposed', { contract: contract({ id: FRONTEND, recipient: 'frontend', runtime: 'codex' }) }, { task_id: FRONTEND, actor: 'planner' });
      log.add('lint_reported', { contract_version: 1, results: [{ ...err, task_id: FRONTEND }] }, { task_id: FRONTEND });
      expect(replay(log.events).metrics.contracts_blocked_before_execution).toBe(2);
    });
  });

  describe('mission', () => {
    it('mission-level clarification: questions stay open until answered, answers accumulate and count as filled fields', () => {
      const log = proposedBackend();
      const missionId = log.events[0]!.mission_id;
      log.add('mission_clarification_requested', { questions: [{ id: 'Q1', text: 'Which mechanism?', blocking: true }, { id: 'Q2', text: 'Cookie or bearer?', blocking: true }] }, { actor: 'planner' });
      let m = replay(log.events).missions[missionId]!;
      expect(m.open_questions?.map((q) => q.id)).toEqual(['Q1', 'Q2']);
      log.add('mission_clarification_answered', { answers: [{ question_id: 'Q1', answer: 'magic link', answered_by: 'human', at: 'x' }] }, { actor: 'human' });
      const s = replay(log.events);
      m = s.missions[missionId]!;
      expect(m.open_questions?.map((q) => q.id)).toEqual(['Q2']);
      expect(m.clarifications?.map((c) => c.answer)).toEqual(['magic link']);
      expect(s.metrics.fields_filled_via_clarification).toBe(1);
    });

    it('mission_created → planning; first task_accepted → executing; integration → integrating; mission_verified → verified', () => {
      const log = proposedBackend();
      let m = replay(log.events).missions[MISSION_ID]!;
      expect(m.status).toBe('planning');
      expect(m.mission.title).toBe('Add secure login');
      expect(m.task_ids).toEqual([BACKEND]);
      log.add('tasks_planned', { task_ids: [BACKEND, FRONTEND] }, { actor: 'planner' });
      m = replay(log.events).missions[MISSION_ID]!;
      expect(m.task_ids).toEqual([BACKEND, FRONTEND]);
      log.add('task_accepted', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'accepted' } }, { task_id: BACKEND, actor: 'agent:backend' });
      expect(replay(log.events).missions[MISSION_ID]!.status).toBe('executing');
      log.add('integration_started', { branch: 'relay/integration', order: [BACKEND] });
      m = replay(log.events).missions[MISSION_ID]!;
      expect(m.status).toBe('integrating');
      expect(m.integration).toEqual({ branch: 'relay/integration', order: [BACKEND] });
      log.add('integration_conflict', { task_id: BACKEND, files: ['a.ts'] });
      m = replay(log.events).missions[MISSION_ID]!;
      expect(m.integration?.conflict).toEqual({ task_id: BACKEND, files: ['a.ts'] });
      log.add('mission_verified', {}, { actor: 'human' });
      expect(replay(log.events).missions[MISSION_ID]!.status).toBe('verified');
    });

    it('mission_failed → failed', () => {
      const log = proposedBackend();
      log.add('mission_failed', { reason: 'conflict' });
      expect(replay(log.events).missions[MISSION_ID]!.status).toBe('failed');
    });
  });

  describe('metrics', () => {
    it('counts clarification answers, criteria, mismatches and repairs', () => {
      const log = acceptedBackend();
      log.add('clarification_answered', { answers: [{ question_id: 'Q1', answer: 'a', answered_by: 'human', at: 'x' }, { question_id: 'Q2', answer: 'b', answered_by: 'human', at: 'x' }] }, { task_id: BACKEND, actor: 'human' });
      log.add('task_proposed', { contract: contract({ id: FRONTEND, recipient: 'frontend', runtime: 'codex', acceptance_criteria: [
        { id: 'AC-1', condition: 'c', check: { kind: 'human_review' } },
        { id: 'AC-2', condition: 'c', check: { kind: 'llm_judge' } },
        { id: 'AC-3', condition: 'c' },
        { id: 'AC-4', condition: 'c', check: { kind: 'file_exists', path: 'x' } },
      ] }) }, { task_id: FRONTEND, actor: 'planner' });
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_recorded', { record: record(1, ['AC-1', 'AC-2']) }, { task_id: BACKEND });
      log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
      const m = replay(log.events).metrics;
      expect(m.fields_filled_via_clarification).toBe(2);
      expect(m.criteria_total).toBe(6);
      expect(m.criteria_with_machine_check).toBe(3);
      expect(m.self_report_mismatches).toBe(2);
      expect(m.repairs_total).toBe(1);
    });

    it('criteria metrics follow the current contract after revision', () => {
      const log = proposedBackend();
      log.add('contract_revised', { contract: contract({ version: 2, acceptance_criteria: [{ id: 'AC-1', condition: 'c', check: { kind: 'diff_scope' } }] }), previous_version: 1 }, { task_id: BACKEND });
      const m = replay(log.events).metrics;
      expect(m.criteria_total).toBe(1);
      expect(m.criteria_with_machine_check).toBe(1);
    });

    it('tasks_not_rerun_on_repair counts other tasks that are executing, awaiting_verification or completed', () => {
      const log = acceptedBackend();
      log.add('task_proposed', { contract: contract({ id: FRONTEND, recipient: 'frontend', runtime: 'codex' }) }, { task_id: FRONTEND, actor: 'planner' });
      log.add('task_proposed', { contract: contract({ id: E2E, recipient: 'e2e' }) }, { task_id: E2E, actor: 'planner' });
      log.add('task_proposed', { contract: contract({ id: 't-other', recipient: 'other', mission_id: 'm-002' }) }, { task_id: 't-other', actor: 'planner', mission_id: 'm-002' });
      log.add('work_started', {}, { task_id: FRONTEND, actor: 'agent:frontend' });
      log.add('task_completed', {}, { task_id: E2E });
      log.add('work_started', {}, { task_id: 't-other', actor: 'agent:other', mission_id: 'm-002' });
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
      expect(replay(log.events).metrics.tasks_not_rerun_on_repair).toBe(2);
      log.add('repair_accepted', { repair_id: repair(1).id }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('evidence_submitted', { submission: { task_id: BACKEND, contract_version: 1, attempt: 2, claimed: {} } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('repair_requested', { repair: repair(2) }, { task_id: BACKEND });
      expect(replay(log.events).metrics.tasks_not_rerun_on_repair).toBe(4);
    });
  });

  describe('unknown references', () => {
    it('ignores task events for unknown tasks but still advances last_seq', () => {
      const log = new EventLog();
      log.add('work_started', {}, { task_id: 't-ghost', actor: 'agent:ghost' });
      const s = reduce(initialState(), log.events[0]!);
      expect(s.tasks).toEqual({});
      expect(s.last_seq).toBe(1);
    });

    it('creates a task on task_proposed even when the mission is unknown', () => {
      const log = new EventLog();
      log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
      const s = replay(log.events);
      expect(s.tasks[BACKEND]?.task_state).toBe('proposed');
      expect(s.missions).toEqual({});
    });
  });
});

// Type-level check: State stays assignable from reducer output.
const _s: State = replay([]);
void _s;

describe('tombstones', () => {
  const withTwoTasks = () => {
    const log = new EventLog();
    log.add('mission_created', mission());
    log.add('task_proposed', { contract: contract({ id: BACKEND }) }, { task_id: BACKEND });
    log.add('task_proposed', { contract: contract({ id: FRONTEND, recipient: 'frontend' }) }, { task_id: FRONTEND });
    return log;
  };

  it('task_deleted drops the task from the state and from its mission', () => {
    const log = withTwoTasks();
    log.add('task_canceled', { reason: 'not needed' }, { task_id: BACKEND });
    const before = replay(log.events);
    expect(before.tasks[BACKEND]).toBeDefined();
    expect(before.missions[MISSION_ID]!.task_ids).toContain(BACKEND);

    log.add('task_deleted', { reason: 'tidying up' }, { task_id: BACKEND });
    const after = replay(log.events);

    expect(after.tasks[BACKEND]).toBeUndefined();
    expect(after.missions[MISSION_ID]!.task_ids).toEqual([FRONTEND]);
    expect(after.tasks[FRONTEND]).toBeDefined();
  });

  it('the log still holds the whole story: replaying up to the delete shows the task alive', () => {
    const log = withTwoTasks();
    log.add('task_canceled', {}, { task_id: BACKEND });
    const upToDelete = log.events.length;
    log.add('task_deleted', {}, { task_id: BACKEND });

    // The point of a tombstone rather than an edit: history is intact, only the view forgets.
    expect(replay(log.events.slice(0, upToDelete)).tasks[BACKEND]).toBeDefined();
    expect(replay(log.events).tasks[BACKEND]).toBeUndefined();
  });

  it('mission_deleted takes its tasks with it and leaves other missions alone', () => {
    const log = withTwoTasks();
    const other = 'm-other';
    log.add('mission_created', { ...mission(), id: other }, { mission_id: other });
    log.add('task_proposed', { contract: contract({ id: E2E, mission_id: other }) }, { task_id: E2E, mission_id: other });

    log.add('mission_deleted', { reason: 'abandoned' });
    const after = replay(log.events);

    expect(after.missions[MISSION_ID]).toBeUndefined();
    expect(after.tasks[BACKEND]).toBeUndefined();
    expect(after.tasks[FRONTEND]).toBeUndefined();
    expect(after.missions[other]).toBeDefined();
    expect(after.tasks[E2E]).toBeDefined();
  });

  it('mission_canceled sets the status without deleting anything', () => {
    const log = withTwoTasks();
    log.add('mission_canceled', { reason: 'changed my mind' });
    const after = replay(log.events);

    expect(after.missions[MISSION_ID]!.status).toBe('canceled');
    expect(after.tasks[BACKEND]).toBeDefined();
  });

  it('deleting what was never there changes nothing, so the reducer stays total', () => {
    const log = withTwoTasks();
    const before = replay(log.events);
    log.add('task_deleted', {}, { task_id: 't-never-existed' });

    const after = replay(log.events);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.missions).toEqual(before.missions);
  });

  it('metrics are not rewritten: forgetting a task does not unmake its repairs', () => {
    const log = withTwoTasks();
    log.add('repair_requested', { repair: repair(1) }, { task_id: BACKEND });
    const withRepair = replay(log.events).metrics.repairs_total;
    expect(withRepair).toBe(1);

    log.add('task_deleted', {}, { task_id: BACKEND });
    expect(replay(log.events).metrics.repairs_total).toBe(1);
  });
});
