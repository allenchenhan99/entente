import { describe, it, expect } from 'vitest';
import { narrate } from './index.js';
import { replay } from '../reducer.js';
import { initialState } from '../state.js';
import { EVENT_TYPES, type Event, type EventType } from '../events.js';
import { EventLog, contract, MISSION_ID } from '../testkit.test.js';
import type { EvidenceRecord, RepairContract } from '../contract.js';

const BACKEND = 't-backend-auth';

const record = (attempt: number, mismatch: string[] = []): EvidenceRecord => ({
  task_id: BACKEND,
  contract_version: 1,
  attempt,
  changed_files: ['src/auth/token.ts'],
  checks: { 'AC-1': { status: mismatch.length ? 'failed' : 'passed' }, 'AC-2': { status: 'passed' }, 'AC-3': { status: 'pending_human' } },
  self_report_mismatch: mismatch,
});

const repair = (n: number): RepairContract => ({
  id: `${BACKEND}/r${n}`,
  parent_task: BACKEND,
  parent_version: 1,
  attempt: n + 1,
  failed_criteria: ['AC-2'],
  observed_failure: 'expected 401, received 200',
  requested_correction: 'Reject expired tokens',
  unchanged_scope: [],
  remaining_repairs: 3 - n,
});

/** A state that knows the backend task, so narrate can name its role. */
function backendState() {
  const log = new EventLog();
  log.add('mission_created', { id: MISSION_ID, repo: '/workspace/demo', title: 'Add secure login' }, { actor: 'human' });
  log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
  return replay(log.events);
}

const payloads: { [T in EventType]: Extract<Event, { type: T }>['payload'] } = {
  mission_created: { id: MISSION_ID, repo: '/workspace/demo', title: 'Add secure login', success_definition: 'all verified', integration_check: 'npx vitest run', budget: { max_repairs_per_task: 3 } },
  mission_clarification_requested: { questions: [{ id: 'Q1', text: 'Which mechanism?', blocking: true }, { id: 'Q2', text: 'Cookie or bearer?', blocking: true }] },
  mission_clarification_answered: { answers: [{ question_id: 'Q1', answer: 'magic link', answered_by: 'human', at: 'x' }] },
  tasks_planned: { task_ids: [BACKEND, 't-frontend-login'] },
  lint_reported: { contract_version: 1, results: [{ rule: 'missing_input', severity: 'error', message: 'inputs must be file paths', task_id: BACKEND, field: 'inputs/0' }] },
  task_proposed: { contract: contract() },
  clarification_requested: { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'needs_clarification', interpretation: [], assumptions: [], risks: [], verification_plan: {}, questions: [{ id: 'Q1', text: 'Expiry?', blocking: true }, { id: 'Q2', text: 'Which store?', blocking: true }] } },
  clarification_answered: { answers: [{ question_id: 'Q1', answer: '15 minutes', answered_by: 'human', at: 'x' }, { question_id: 'Q2', answer: 'redis', answered_by: 'human', at: 'x' }] },
  contract_revised: { contract: contract({ version: 2 }), previous_version: 1 },
  task_accepted: { contract_version: 2, response: { task_id: BACKEND, contract_version: 2, decision: 'accepted', interpretation: ['only backend endpoints', 'reuse the session store'], assumptions: [], risks: [], verification_plan: {}, questions: [] } },
  task_rejected: { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'rejected', interpretation: [], assumptions: [], risks: [], verification_plan: {}, questions: [], reason: 'out of my scope' } },
  worktree_created: { path: '/wt/backend', branch: 'relay/t-backend-auth', base: 'main' },
  agent_spawned: { runtime: 'claude-code', pane_id: '%1', session_id: 's1', cwd: '/wt/backend' },
  agent_exited: { pane_id: '%1', exit_reason: 'done' },
  work_started: {},
  progress_reported: { message: 'half way', percent: 50 },
  task_blocked: { reason: 'waiting on schema', waiting_on: 't-auth-schema' },
  task_unblocked: {},
  blocker_replied: { message: 'schema is on branch relay/t-auth-schema' },
  evidence_submitted: { submission: { task_id: BACKEND, contract_version: 1, attempt: 1, claimed: { 'AC-1': { status: 'passed' }, 'AC-2': { status: 'passed' }, 'AC-3': { status: 'skipped' } }, summary: 'tokens expire' } },
  checks_started: { attempt: 1 },
  check_passed: { attempt: 1, criterion_id: 'AC-1', result: { status: 'passed', duration_ms: 1200 } },
  check_failed: { attempt: 1, criterion_id: 'AC-2', result: { status: 'failed', observed: 'expected 401, received 200' } },
  human_review_recorded: { attempt: 1, criterion_id: 'AC-3', status: 'failed', observed_failure: 'replay created a second session' },
  evidence_recorded: { record: record(1, ['AC-1']) },
  repair_requested: { repair: repair(1) },
  repair_accepted: { repair_id: `${BACKEND}/r1` },
  task_verified: { attempt: 2 },
  task_completed: {},
  task_failed_budget: { attempts: 4, reason: 'max repairs exhausted' },
  task_escalated: { reason: 'stagnation on AC-1', failed_criteria: ['AC-1'] },
  task_canceled: { reason: 'superseded' },
  integration_started: { branch: 'relay/integration', order: [BACKEND, 't-frontend-login'] },
  integration_conflict: { task_id: BACKEND, files: ['src/auth/token.ts'] },
  mission_verified: {},
  mission_failed: { reason: 'integration check failed' },
  mission_canceled: { reason: 'changed my mind' },
  task_deleted: { reason: 'tidying up' },
  mission_deleted: { reason: 'abandoned' },
};

const actorFor: Partial<Record<EventType, string>> = {
  mission_created: 'human',
  mission_clarification_requested: 'planner',
  mission_clarification_answered: 'human',
  tasks_planned: 'planner',
  task_proposed: 'planner',
  contract_revised: 'planner',
  clarification_requested: 'agent:backend',
  clarification_answered: 'human',
  task_accepted: 'agent:backend',
  task_rejected: 'agent:backend',
  work_started: 'agent:backend',
  progress_reported: 'agent:backend',
  task_blocked: 'agent:backend',
  task_unblocked: 'agent:backend',
  blocker_replied: 'human',
  evidence_submitted: 'agent:backend',
  human_review_recorded: 'human',
  repair_accepted: 'agent:backend',
  task_canceled: 'human',
};

function event<T extends EventType>(type: T, overrides: Partial<{ task_id: string; actor: string }> = {}): Event {
  const log = new EventLog();
  const missionLevel = type.startsWith('mission_') || type === 'tasks_planned' || type.startsWith('integration_');
  return log.add(type, payloads[type] as never, { task_id: missionLevel ? undefined : BACKEND, actor: actorFor[type] ?? 'relayd', ...overrides });
}

describe('narrate', () => {
  it('returns one non-empty sentence for every EVENT_TYPES member, never echoing the raw type', () => {
    const state = backendState();
    expect(EVENT_TYPES).toHaveLength(39);
    for (const type of EVENT_TYPES) {
      const line = narrate(event(type), state);
      expect(line.trim().length, type).toBeGreaterThan(0);
      expect(line, type).not.toContain(type);
      expect(line, type).not.toMatch(/\bagent:/);
      expect(line, type).not.toMatch(/\brelayd\b/);
    }
  });

  it('is total: every event type narrates on the initial state (unknown task/mission)', () => {
    for (const type of EVENT_TYPES) {
      const line = narrate(event(type), initialState());
      expect(line.trim().length, type).toBeGreaterThan(0);
      expect(line, type).not.toContain(type);
    }
  });

  describe('the eight pinned shapes', () => {
    const state = backendState();
    const n = (type: EventType) => narrate(event(type), state);

    it('task_proposed', () => {
      expect(n('task_proposed')).toBe('planner proposes t-backend-auth v1 to backend: "Implement email magic-link authentication endpoints" (2 criteria, paths src/auth/**, tests/auth/**)');
    });
    it('clarification_requested', () => {
      expect(n('clarification_requested')).toBe('backend asks 2 questions before starting: Q1 Expiry?; Q2 Which store?');
    });
    it('task_accepted', () => {
      expect(n('task_accepted')).toBe('backend accepts v2 and restates it: only backend endpoints; reuse the session store');
    });
    it('check_failed', () => {
      expect(n('check_failed')).toBe('RelayGraph runs AC-2: failed — expected 401, received 200');
    });
    it('repair_requested', () => {
      expect(n('repair_requested')).toBe('RelayGraph opens repair r1 for AC-2 only (2 repairs left)');
    });
    it('task_blocked', () => {
      expect(n('task_blocked')).toBe('backend is stuck: waiting on schema (waiting on t-auth-schema)');
    });
    it('blocker_replied', () => {
      expect(n('blocker_replied')).toBe('you reply to backend: "schema is on branch relay/t-auth-schema"');
    });
    it('mission_clarification_requested', () => {
      const six = { questions: [1, 2, 3, 4, 5, 6].map((i) => ({ id: `Q${i}`, text: `Question ${i}?`, blocking: true })) };
      const e = new EventLog().add('mission_clarification_requested', six, { actor: 'planner' });
      expect(narrate(e, state)).toBe('planner asks you 6 questions before decomposing: Q1 Question 1?; Q2 Question 2?; Q3 Question 3?; Q4 Question 4?; Q5 Question 5?; Q6 Question 6?');
    });
  });

  describe('voice and naming', () => {
    const state = backendState();

    it('names the human "you", relayd "RelayGraph", agents by role, and uses present tense', () => {
      expect(narrate(event('mission_created'), state)).toMatch(/^you create /);
      expect(narrate(event('check_passed'), state)).toBe('RelayGraph runs AC-1: passed');
      expect(narrate(event('work_started'), state)).toBe('backend starts working on t-backend-auth');
      expect(narrate(event('task_unblocked', { actor: 'human' }), state)).toBe('you unblock backend');
      expect(narrate(event('task_unblocked'), state)).toBe('backend resumes work');
    });

    it('resolves the role from state when the actor is not the agent (relayd verifying backend)', () => {
      expect(narrate(event('task_verified'), state)).toBe('RelayGraph verifies backend: every criterion of attempt 2 passed');
      expect(narrate(event('human_review_recorded'), state)).toBe('you mark AC-3 failed — replay created a second session');
      expect(narrate(event('evidence_submitted'), state)).toBe('backend submits evidence #1 claiming 2 passed, 1 skipped: "tokens expire"');
      expect(narrate(event('evidence_recorded'), state)).toBe('RelayGraph records attempt 1: 1 passed, 1 failed, 1 pending review (self-report mismatch on AC-1)');
      expect(narrate(event('lint_reported'), state)).toBe('RelayGraph lints t-backend-auth v1: 1 error — missing_input: inputs must be file paths');
      expect(narrate(event('task_escalated'), state)).toBe('RelayGraph escalates t-backend-auth to you: stagnation on AC-1 (AC-1)');
    });

    it('truncates long quotes to 120 characters with an ellipsis', () => {
      const long = 'x'.repeat(300);
      const e = new EventLog().add('progress_reported', { message: long }, { task_id: BACKEND, actor: 'agent:backend' });
      const line = narrate(e, state);
      expect(line).toBe(`backend reports: "${'x'.repeat(119)}…"`);
    });
  });
});
