import { describe, it, expect } from 'vitest';
import { actionsFor, buildGraph } from './index.js';
import { replay } from '../reducer.js';
import { loadFixture, replayUntil } from './testkit.test.js';

const BACKEND = 't-backend-auth';
const keys = (list: { key: string; kind: string }[]) => list.map((a) => `${a.key}:${a.kind}`);

describe('actionsFor', () => {
  const live1 = loadFixture('events-live-1.jsonl');
  const live2 = loadFixture('events-live-2.jsonl');
  const live4 = loadFixture('events-live-4.jsonl');

  it('agent node with open questions: clarify, focus, inspect, cancel in that order', () => {
    const { state } = replayUntil(live2, (e) => e.type === 'clarification_requested' && e.task_id === BACKEND);
    const g = buildGraph(state);
    const actions = actionsFor({ kind: 'node', id: BACKEND }, g, state);
    expect(keys(actions)).toEqual(['a:clarify', 'Enter:focus', 'i:inspect', 'x:cancel']);
    expect(actions[0]!.target).toEqual({ task_id: BACKEND, question_ids: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] });
    expect(actions[1]!.target).toEqual({ task_id: BACKEND });
  });

  it('contract edge in needs_clarification: clarify, inspect, cancel; question edge: clarify, inspect', () => {
    const { state } = replayUntil(live2, (e) => e.type === 'clarification_requested' && e.task_id === BACKEND);
    const g = buildGraph(state);
    expect(keys(actionsFor({ kind: 'edge', id: `contract:${BACKEND}` }, g, state))).toEqual(['a:clarify', 'i:inspect', 'x:cancel']);
    expect(keys(actionsFor({ kind: 'edge', id: `question:${BACKEND}` }, g, state))).toEqual(['a:clarify', 'i:inspect']);
  });

  it('pending human review: p/f review actions on the evidence edge and the agent node', () => {
    const { state } = replayUntil(live1, (e) => e.type === 'evidence_recorded');
    const g = buildGraph(state);
    const edge = actionsFor({ kind: 'edge', id: `evidence:${BACKEND}` }, g, state);
    expect(keys(edge)).toEqual(['p:review', 'f:review', 'i:inspect', 'x:cancel']);
    expect(edge[0]).toEqual({ key: 'p', kind: 'review', label: 'mark AC-3 passed', target: { task_id: BACKEND, criterion_id: 'AC-3' } });
    expect(edge[1]).toEqual({ key: 'f', kind: 'review', label: 'mark AC-3 failed', target: { task_id: BACKEND, criterion_id: 'AC-3' } });
    expect(keys(actionsFor({ kind: 'node', id: BACKEND }, g, state))).toEqual(['p:review', 'f:review', 'Enter:focus', 'i:inspect', 'x:cancel']);
  });

  it('blocked task: reply, focus, inspect, cancel', () => {
    const { state } = replayUntil(live1, (e) => e.type === 'task_blocked');
    const g = buildGraph(state);
    const actions = actionsFor({ kind: 'node', id: BACKEND }, g, state);
    expect(keys(actions)).toEqual(['r:reply', 'Enter:focus', 'i:inspect', 'x:cancel']);
    expect(actions[0]!.target).toEqual({ task_id: BACKEND });
  });

  it('completed task: only focus and inspect (no cancel); canceled task with no pane: only inspect', () => {
    const state = replay(live1);
    const g = buildGraph(state);
    expect(keys(actionsFor({ kind: 'node', id: BACKEND }, g, state))).toEqual(['Enter:focus', 'i:inspect']);
    expect(keys(actionsFor({ kind: 'node', id: 't-frontend-login' }, g, state))).toEqual(['Enter:focus', 'i:inspect']);
  });

  it('mission question: planner node and question:mission edge offer mission_clarify', () => {
    const { state } = replayUntil(live4, (e) => e.type === 'mission_clarification_requested');
    const g = buildGraph(state);
    const missionId = Object.keys(state.missions)[0]!;
    const expected = { key: 'a', kind: 'mission_clarify', target: { mission_id: missionId, question_ids: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] } };
    expect(actionsFor({ kind: 'node', id: 'planner' }, g, state)[0]).toMatchObject(expected);
    expect(actionsFor({ kind: 'edge', id: 'question:mission' }, g, state)[0]).toMatchObject(expected);
    expect(keys(actionsFor({ kind: 'edge', id: 'question:mission' }, g, state))).toEqual(['a:mission_clarify', 'i:inspect']);
    expect(keys(actionsFor({ kind: 'node', id: 'planner' }, g, state))).toEqual(['a:mission_clarify', 'i:inspect']);
  });

  it('inbox refs return the item actions; human and verifier nodes only inspect; unknown refs return []', () => {
    const { state } = replayUntil(live4, (e) => e.type === 'mission_clarification_requested');
    const g = buildGraph(state);
    expect(actionsFor({ kind: 'inbox', id: g.inbox[0]!.id }, g, state)).toEqual(g.inbox[0]!.actions);
    expect(keys(actionsFor({ kind: 'node', id: 'human' }, g, state))).toEqual(['i:inspect']);
    expect(keys(actionsFor({ kind: 'node', id: 'verifier' }, g, state))).toEqual(['i:inspect']);
    expect(actionsFor({ kind: 'node', id: 'nope' }, g, state)).toEqual([]);
    expect(actionsFor({ kind: 'edge', id: 'contract:nope' }, g, state)).toEqual([]);
    expect(actionsFor({ kind: 'inbox', id: 'nope' }, g, state)).toEqual([]);
  });

  it('dependency and reply edges offer inspect only', () => {
    const state = replay(live4);
    const g = buildGraph(state);
    expect(keys(actionsFor({ kind: 'edge', id: 'dep:t-magic-link-core->t-auth-routes' }, g, state))).toEqual(['i:inspect']);
    const s2 = replay(live2);
    expect(keys(actionsFor({ kind: 'edge', id: `reply:${BACKEND}` }, buildGraph(s2), s2))).toEqual(['i:inspect']);
  });
});
