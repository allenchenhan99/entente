import { describe, it, expect } from 'vitest';
import { buildGraph } from './index.js';
import { replay } from '../reducer.js';
import { loadFixture, replayUntil } from './testkit.test.js';

const CORE = 't-magic-link-core';
const ROUTES = 't-auth-routes';
const LOGIN = 't-login-page';
const BACKEND = 't-backend-auth';

describe('buildGraph', () => {
  describe('live-4 (planner asks first, serial chain)', () => {
    const events = loadFixture('events-live-4.jsonl');

    it('final state: fixed nodes plus three verified agents', () => {
      const g = buildGraph(replay(events));
      expect(g.nodes.map((n) => n.id)).toEqual(['human', 'planner', ROUTES, LOGIN, CORE, 'verifier']);
      expect(g.nodes.map((n) => n.column)).toEqual([0, 0, 1, 1, 1, 2]);
      const core = g.nodes.find((n) => n.id === CORE)!;
      expect(core.kind).toBe('agent');
      expect(core.label).toBe('core-dev');
      expect(core.task_id).toBe(CORE);
      expect(core.status).toBe('verified');
      expect(core.badge).toBe('a1');
      expect(core.runtime).toBe('done');
      expect(core.task_state).toBe('completed');
      expect(core.handoff_state).toBe('verified');
      expect(g.nodes.find((n) => n.id === 'planner')!.status).toBe('verified');
      expect(g.nodes.find((n) => n.id === 'verifier')!.status).toBe('verified');
    });

    it('final state: 3 verified contract edges, 3 verified evidence edges, 2 dependency edges, no reply edge', () => {
      const g = buildGraph(replay(events));
      const byKind = (k: string) => g.edges.filter((e) => e.kind === k);
      expect(byKind('contract').map((e) => e.id)).toEqual([`contract:${ROUTES}`, `contract:${LOGIN}`, `contract:${CORE}`]);
      for (const e of byKind('contract')) {
        expect(e.from).toBe('planner');
        expect(e.to).toBe(e.task_id);
        expect(e.label).toBe('v1 ✓');
        expect(e.status).toBe('verified');
        expect(e.attention).toBe(false);
        expect(e.version).toBe(1);
      }
      expect(byKind('evidence').map((e) => e.id)).toEqual([`evidence:${ROUTES}`, `evidence:${LOGIN}`, `evidence:${CORE}`]);
      for (const e of byKind('evidence')) {
        expect(e.from).toBe(e.task_id);
        expect(e.to).toBe('verifier');
        expect(e.label).toBe('✓');
        expect(e.status).toBe('verified');
      }
      expect(byKind('dependency')).toEqual([
        { id: `dep:${ROUTES}->${LOGIN}`, kind: 'dependency', from: ROUTES, to: LOGIN, task_id: LOGIN, label: 'dep', status: 'verified', attention: false },
        { id: `dep:${CORE}->${ROUTES}`, kind: 'dependency', from: CORE, to: ROUTES, task_id: ROUTES, label: 'dep', status: 'verified', attention: false },
      ]);
      expect(byKind('reply')).toEqual([]);
      expect(byKind('question')).toEqual([]);
      expect(g.edges.map((e) => e.kind)).toEqual([...g.edges.map((e) => e.kind)].sort());
      expect(g.inbox).toEqual([]);
    });

    it('after the first 3 events: a mission_question inbox item with 6 detail lines and a mission_clarify action', () => {
      const { state } = replayUntil(events, (e) => e.type === 'mission_clarification_requested');
      const g = buildGraph(state);
      expect(g.nodes.map((n) => n.id)).toEqual(['human', 'planner', 'verifier']);
      expect(g.nodes.find((n) => n.id === 'planner')!.status).toBe('attention');
      expect(g.nodes.find((n) => n.id === 'human')!.status).toBe('attention');
      expect(g.inbox.map((i) => i.kind)).toEqual(['mission_question']);
      const item = g.inbox[0]!;
      expect(item.mission_id).toBe(state.missions[Object.keys(state.missions)[0]!]!.mission.id);
      expect(item.detail).toHaveLength(6);
      expect(item.detail[0]).toMatch(/^Q1: .+/);
      expect(item.detail[5]).toMatch(/^Q6: .+/);
      expect(item.title).toMatch(/planner asks you 6 questions/);
      expect(item.ref).toEqual({ kind: 'edge', id: 'question:mission' });
      expect(item.actions).toContainEqual({
        key: 'a',
        kind: 'mission_clarify',
        label: expect.any(String),
        target: { mission_id: item.mission_id, question_ids: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] },
      });
      const q = g.edges.find((e) => e.id === 'question:mission')!;
      expect(q).toMatchObject({ kind: 'question', from: 'planner', to: 'human', label: '? 6', status: 'attention', attention: true });
    });

    it('while the chain is executing, the dependency edge carries the producer status and the consumer stays pending', () => {
      const { state } = replayUntil(events, (e) => e.type === 'task_proposed' && e.task_id === LOGIN);
      const g = buildGraph(state);
      expect(g.nodes.find((n) => n.id === CORE)!.status).toBe('working');
      expect(g.nodes.find((n) => n.id === ROUTES)!.status).toBe('pending');
      expect(g.edges.find((e) => e.id === `dep:${CORE}->${ROUTES}`)!.status).toBe('working');
      expect(g.edges.find((e) => e.id === `contract:${ROUTES}`)).toMatchObject({ label: 'v1', status: 'pending', attention: false });
      expect(g.edges.find((e) => e.id === `contract:${CORE}`)).toMatchObject({ label: 'v1 ✓', status: 'done' });
      expect(g.edges.find((e) => e.id === `evidence:${CORE}`)).toMatchObject({ label: 'awaiting evidence', status: 'pending' });
      expect(g.edges.find((e) => e.id === `evidence:${ROUTES}`)).toBeUndefined();
    });
  });

  describe('live-1 (human review fails, repair, blocker, verified)', () => {
    const events = loadFixture('events-live-1.jsonl');

    it('after evidence_recorded with a pending human review: evidence edge needs attention and inbox has a human_review item', () => {
      const { state } = replayUntil(events, (e) => e.type === 'evidence_recorded');
      const g = buildGraph(state);
      const ev = g.edges.find((e) => e.id === `evidence:${BACKEND}`)!;
      expect(ev).toMatchObject({ label: '#1', status: 'attention', attention: true });
      expect(g.nodes.find((n) => n.id === BACKEND)).toMatchObject({ status: 'attention', badge: 'a1' });
      expect(g.inbox.map((i) => i.kind)).toEqual(['human_review']);
      const item = g.inbox[0]!;
      expect(item.task_id).toBe(BACKEND);
      expect(item.detail).toHaveLength(1);
      expect(item.actions.map((a) => [a.key, a.kind])).toEqual(expect.arrayContaining([['p', 'review'], ['f', 'review']]));
      expect(item.actions.find((a) => a.key === 'p')).toMatchObject({ label: 'mark AC-3 passed', target: { task_id: BACKEND, criterion_id: 'AC-3' } });
      expect(item.actions.find((a) => a.key === 'f')).toMatchObject({ label: 'mark AC-3 failed', target: { task_id: BACKEND, criterion_id: 'AC-3' } });
    });

    it('after repair_requested: evidence edge label starts with AC-3 and needs attention', () => {
      const { state } = replayUntil(events, (e) => e.type === 'repair_requested');
      const g = buildGraph(state);
      const ev = g.edges.find((e) => e.id === `evidence:${BACKEND}`)!;
      expect(ev.label.startsWith('AC-3')).toBe(true);
      expect(ev.attention).toBe(true);
      expect(ev.status).toBe('attention');
      expect(g.inbox).toEqual([]);
    });

    it('after task_blocked: node badge ◐ blocked and a blocker inbox item with a reply action', () => {
      const { state } = replayUntil(events, (e) => e.type === 'task_blocked');
      const g = buildGraph(state);
      const node = g.nodes.find((n) => n.id === BACKEND)!;
      expect(node.badge).toBe('◐ blocked');
      expect(node.status).toBe('blocked');
      expect(g.inbox.map((i) => i.kind)).toEqual(['blocker']);
      const item = g.inbox[0]!;
      expect(item.task_id).toBe(BACKEND);
      expect(item.since).toBe(state.tasks[BACKEND]!.blocker!.since);
      expect(item.detail.length).toBeGreaterThanOrEqual(2);
      expect(item.detail.at(-1)).toMatch(/^waiting on /);
      expect(item.actions).toContainEqual({ key: 'r', kind: 'reply', label: expect.any(String), target: { task_id: BACKEND } });
      expect(item.ref).toEqual({ kind: 'node', id: BACKEND });
      expect(g.edges.find((e) => e.id === `evidence:${BACKEND}`)).toMatchObject({ label: 'awaiting evidence', status: 'pending' });
    });

    it('final state: contract edge verified, canceled frontend failed, inbox empty', () => {
      const g = buildGraph(replay(events));
      expect(g.edges.find((e) => e.id === `contract:${BACKEND}`)).toMatchObject({ label: 'v1 ✓', status: 'verified', attention: false });
      expect(g.edges.find((e) => e.id === `evidence:${BACKEND}`)).toMatchObject({ label: '✓', status: 'verified' });
      expect(g.nodes.find((n) => n.id === 't-frontend-login')).toMatchObject({ status: 'failed', label: 'frontend' });
      expect(g.edges.find((e) => e.id === 'evidence:t-frontend-login')).toBeUndefined();
      expect(g.inbox).toEqual([]);
    });
  });

  describe('live-2 (both agents ask before starting)', () => {
    const events = loadFixture('events-live-2.jsonl');

    it('while questions are open: question edges, task_question inbox items oldest proposal first, node badge ? n', () => {
      const { state } = replayUntil(events, (e) => e.type === 'clarification_requested' && e.task_id === BACKEND);
      const g = buildGraph(state);
      expect(g.nodes.find((n) => n.id === BACKEND)).toMatchObject({ status: 'attention', badge: '? 6' });
      expect(g.edges.find((e) => e.id === `contract:${BACKEND}`)).toMatchObject({ label: '? 6', status: 'attention', attention: true });
      expect(g.edges.find((e) => e.id === `question:${BACKEND}`)).toMatchObject({ from: BACKEND, to: 'human', label: '? 6', attention: true });
      // State records no "asked at" timestamp, so items are ordered by the proposal time of the questioned version.
      expect(g.inbox.map((i) => [i.kind, i.task_id])).toEqual([['task_question', BACKEND], ['task_question', 't-frontend-login']]);
      expect(g.inbox[0]!.since).toBe(state.tasks[BACKEND]!.proposed_at);
      expect(g.inbox[0]!.detail).toHaveLength(6);
      expect(g.inbox[0]!.actions[0]).toMatchObject({ key: 'a', kind: 'clarify', target: { task_id: BACKEND, question_ids: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] } });
    });

    it('after answers: reply edge ↩ n from human, contract v2 ✓ once accepted', () => {
      const g = buildGraph(replay(events));
      expect(g.edges.find((e) => e.id === `reply:${BACKEND}`)).toMatchObject({ kind: 'reply', from: 'human', to: BACKEND, label: '↩ 6', status: 'done' });
      expect(g.edges.find((e) => e.id === `contract:${BACKEND}`)).toMatchObject({ label: 'v2 ✓', version: 2, status: 'verified' });
      expect(g.inbox).toEqual([]);
    });
  });

  describe('repair fixture (lint-blocked contract)', () => {
    const events = loadFixture('events-repair.jsonl');

    it('a contract with lint errors shows lint ✗ and a lint_error inbox item until it is revised', () => {
      const { state } = replayUntil(events, (e) => e.type === 'lint_reported' && e.task_id === 't-frontend-login');
      const g = buildGraph(state);
      expect(g.edges.find((e) => e.id === 'contract:t-frontend-login')).toMatchObject({ label: 'lint ✗', status: 'attention', attention: true });
      expect(g.inbox.map((i) => i.kind)).toEqual(['lint_error']);
      expect(g.inbox[0]!.detail[0]).toMatch(/unverifiable_criterion/);
    });
  });

  it('is total on the initial state', () => {
    const g = buildGraph(replay([]));
    expect(g.nodes.map((n) => n.id)).toEqual(['human', 'planner', 'verifier']);
    expect(g.edges).toEqual([]);
    expect(g.inbox).toEqual([]);
  });
});
