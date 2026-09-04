import { describe, it, expect } from 'vitest';
import { buildGraph, describe as describeObject } from './index.js';
import { replay } from '../reducer.js';
import { loadFixture, replayUntil } from './testkit.test.js';

const BACKEND = 't-backend-auth';

describe('describe', () => {
  const repairLog = loadFixture('events-repair.jsonl');
  const live1 = loadFixture('events-live-1.jsonl');
  const live4 = loadFixture('events-live-4.jsonl');

  it('contract edge after a failed check: every criterion with its check status', () => {
    const { state } = replayUntil(repairLog, (e) => e.type === 'evidence_recorded' && e.task_id === BACKEND);
    const g = buildGraph(state);
    const d = describeObject({ kind: 'edge', id: `contract:${BACKEND}` }, g, state);
    expect(d.title).toBe('t-backend-auth v2 (evidence_submitted)');
    expect(d.lines[0]).toBe('Implement email magic-link authentication endpoints (/auth/request and /auth/verify)');
    expect(d.lines[1]).toBe('scope: src/auth/**, src/routes/auth.ts, tests/auth/**');
    expect(d.lines[2]).toBe('non-goals: OAuth login, Account recovery, Frontend UI');
    expect(d.lines.slice(3, 7)).toEqual([
      'AC-1 ✓ command: npx vitest run tests/auth/valid-link.test.ts',
      'AC-2 ✗ command: npx vitest run tests/auth/expired-link.test.ts — GET /auth/verify with an expired token returned 200; expected 401',
      'AC-3 ⏳ human_review',
      'AC-4 ✓ diff_scope',
    ]);
    expect(d.lines[7]).toBe('versions: v1 → v2 (2 clarifications)');
  });

  it('contract edge once verified: the human_review criterion counts as passed; unchecked criteria before evidence show no verdict', () => {
    const final = replay(repairLog);
    const d = describeObject({ kind: 'edge', id: `contract:${BACKEND}` }, buildGraph(final), final);
    expect(d.title).toBe('t-backend-auth v2 (verified)');
    expect(d.lines.filter((l) => /^AC-/.test(l))).toEqual([
      'AC-1 ✓ command: npx vitest run tests/auth/valid-link.test.ts',
      'AC-2 ✓ command: npx vitest run tests/auth/expired-link.test.ts',
      'AC-3 ✓ human_review',
      'AC-4 ✓ diff_scope',
    ]);
    const { state } = replayUntil(repairLog, (e) => e.type === 'task_proposed' && e.task_id === BACKEND);
    const early = describeObject({ kind: 'edge', id: `contract:${BACKEND}` }, buildGraph(state), state);
    expect(early.title).toBe('t-backend-auth v1 (proposed)');
    expect(early.lines.filter((l) => /^AC-/.test(l))[0]).toBe('AC-1 · command: npx vitest run tests/auth/valid-link.test.ts');
    expect(early.lines.at(-1)).toBe('versions: v1');
  });

  it('agent node: role, the three states, worktree, attempt and blocker', () => {
    const { state } = replayUntil(live1, (e) => e.type === 'task_blocked');
    const d = describeObject({ kind: 'node', id: BACKEND }, buildGraph(state), state);
    expect(d.title).toBe('backend · t-backend-auth');
    expect(d.lines[0]).toBe('role: backend (claude-code, pane %0)'.replace('%0', state.tasks[BACKEND]!.agent!.pane_id));
    expect(d.lines[1]).toBe('runtime: blocked · task: repairing · handoff: accepted');
    expect(d.lines[2]).toBe(`worktree: ${state.tasks[BACKEND]!.worktree!.path} (${state.tasks[BACKEND]!.worktree!.branch})`);
    expect(d.lines[3]).toBe('attempt: 1 · repairs: 1 (r1 open for AC-3)');
    expect(d.lines[4]).toMatch(/^blocker: .+ \(waiting on human reviewer: exact reproduction steps for the AC-3 token replay observation\)$/);
  });

  it('agent node with dependencies lists them with their state', () => {
    const { state } = replayUntil(live4, (e) => e.type === 'task_proposed' && e.task_id === 't-login-page');
    const d = describeObject({ kind: 'node', id: 't-auth-routes' }, buildGraph(state), state);
    expect(d.lines).toContain('depends on: t-magic-link-core (executing)');
    expect(d.lines).toContain('runtime: unspawned · task: proposed · handoff: proposed');
  });

  it('verifier: criteria, machine-checked and mismatch counts from metrics', () => {
    const state = replay(repairLog);
    const d = describeObject({ kind: 'node', id: 'verifier' }, buildGraph(state), state);
    expect(d.title).toBe('verifier');
    expect(d.lines[0]).toBe('9 criteria, 8 machine-checked, 1 mismatch');
    expect(d.lines[1]).toBe('1 repair, 3 tasks verified');
  });

  it('human: open inbox count; planner: mission title, status and open questions', () => {
    const { state } = replayUntil(live4, (e) => e.type === 'mission_clarification_requested');
    const g = buildGraph(state);
    const human = describeObject({ kind: 'node', id: 'human' }, g, state);
    expect(human.title).toBe('you');
    expect(human.lines[0]).toBe('1 open inbox item');
    const planner = describeObject({ kind: 'node', id: 'planner' }, g, state);
    expect(planner.title).toBe('planner');
    const mission = Object.values(state.missions)[0]!;
    expect(planner.lines[0]).toBe(`mission ${mission.mission.id}: ${mission.mission.title} (planning)`);
    expect(planner.lines[1]).toBe('0 tasks planned');
    expect(planner.lines[2]).toBe('6 open questions for you');
    const done = replay(live4);
    const dh = describeObject({ kind: 'node', id: 'human' }, buildGraph(done), done);
    expect(dh.lines[0]).toBe('0 open inbox items');
  });

  it('inbox item: its title then detail', () => {
    const { state } = replayUntil(live1, (e) => e.type === 'task_blocked');
    const g = buildGraph(state);
    const item = g.inbox[0]!;
    const d = describeObject({ kind: 'inbox', id: item.id }, g, state);
    expect(d.title).toBe(item.title);
    expect(d.lines).toEqual(item.detail);
  });

  it('evidence, dependency, question and reply edges describe their facts; unknown refs are total', () => {
    const state = replay(repairLog);
    const g = buildGraph(state);
    const ev = describeObject({ kind: 'edge', id: `evidence:${BACKEND}` }, g, state);
    expect(ev.title).toBe('t-backend-auth evidence #2 (verified)');
    expect(ev.lines).toContain('attempt 1: 2 passed, 1 failed, 1 pending review (self-report mismatch on AC-2)');
    expect(ev.lines).toContain('attempt 2: 3 passed, 1 pending review');
    expect(ev.lines).toContain('repair r1: AC-2 — GET /auth/verify with an expired token returned 200; expected 401');
    const dep = describeObject({ kind: 'edge', id: 'dep:t-backend-auth->t-e2e-tests' }, g, state);
    expect(dep.title).toBe('t-e2e-tests depends on t-backend-auth');
    expect(dep.lines[0]).toBe('t-backend-auth: completed (verified)');
    const reply = describeObject({ kind: 'edge', id: `reply:${BACKEND}` }, g, state);
    expect(reply.title).toBe('you → backend (2 answers)');
    expect(reply.lines).toHaveLength(2);
    expect(reply.lines[0]).toMatch(/^Q1: /);
    const { state: qs } = replayUntil(repairLog, (e) => e.type === 'clarification_requested');
    const q = describeObject({ kind: 'edge', id: `question:${BACKEND}` }, buildGraph(qs), qs);
    expect(q.title).toBe('backend asks 2 questions (v1)');
    expect(q.lines).toHaveLength(2);
    expect(describeObject({ kind: 'node', id: 'nope' }, g, state)).toEqual({ title: 'nope', lines: [] });
    expect(describeObject({ kind: 'edge', id: 'weird' }, g, state)).toEqual({ title: 'weird', lines: [] });
  });
});
