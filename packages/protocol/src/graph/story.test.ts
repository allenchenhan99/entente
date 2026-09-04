import { clockLabel } from './story.js';
import { describe, it, expect } from 'vitest';
import { buildGraph, storyFor } from './index.js';
import { replay } from '../reducer.js';
import { loadFixture, replayUntil } from './testkit.test.js';

const BACKEND = 't-backend-auth';
const HHMM = /^\d\d:\d\d /;

describe('storyFor', () => {
  const live2 = loadFixture('events-live-2.jsonl');
  const live4 = loadFixture('events-live-4.jsonl');
  const live1 = loadFixture('events-live-1.jsonl');
  const repairLog = loadFixture('events-repair.jsonl');

  it('story of the backend node on live-2: every backend event, in seq order, each with an HH:MM prefix', () => {
    const state = replay(live2);
    const g = buildGraph(state);
    const story = storyFor({ kind: 'node', id: BACKEND }, g, state, live2);
    const backendEvents = live2.filter((e) => e.task_id === BACKEND);
    expect(story.length).toBeGreaterThanOrEqual(8);
    expect(story).toHaveLength(backendEvents.length);
    for (const [i, line] of story.entries()) {
      expect(line).toMatch(HHMM);
      expect(line.slice(0, 5)).toBe(clockLabel(backendEvents[i]!.ts));
    }
    expect(story[0]).toMatch(/you propose t-backend-auth v1 to backend/);
    expect(story.some((l) => /spawns backend/.test(l))).toBe(true);
    expect(story.some((l) => /backend asks 6 questions/.test(l))).toBe(true);
    expect(story.at(-1)).toMatch(/backend completes t-backend-auth/);
    expect(story.some((l) => /t-frontend-login|^\d\d:\d\d frontend /.test(l))).toBe(false);
  });

  it('story of the planner on live-4 starts with the mission and its 6 questions, then the plans and integration', () => {
    const state = replay(live4);
    const g = buildGraph(state);
    const story = storyFor({ kind: 'node', id: 'planner' }, g, state, live4);
    expect(story[0]).toMatch(/^\d\d:\d\d you create mission /);
    expect(story[1]).toMatch(/^\d\d:\d\d planner asks you 6 questions before decomposing: Q1 /);
    expect(story[2]).toMatch(/^\d\d:\d\d you answer 6 mission questions/);
    expect(story.filter((l) => /planner proposes t-/.test(l))).toHaveLength(3);
    expect(story.at(-2)).toMatch(/integrates .* into /);
    expect(story.at(-1)).toMatch(/verifies the mission/);
    expect(story.some((l) => /reports:|starts working|submits evidence|runs AC-/.test(l))).toBe(false);
  });

  it('story of the human lists only human-actor events', () => {
    const state = replay(live1);
    const g = buildGraph(state);
    const story = storyFor({ kind: 'node', id: 'human' }, g, state, live1);
    expect(story).toHaveLength(live1.filter((e) => e.actor === 'human').length);
    expect(story.every((l) => / you /.test(l))).toBe(true);
  });

  it('story of the verifier: checks, records, verifications and integration only', () => {
    const state = replay(live4);
    const g = buildGraph(state);
    const story = storyFor({ kind: 'node', id: 'verifier' }, g, state, live4);
    const expected = live4.filter((e) => /^(checks_|check_|evidence_recorded|task_verified|integration_)/.test(e.type));
    expect(story).toHaveLength(expected.length);
    expect(story.every((l) => /RelayGraph/.test(l))).toBe(true);
  });

  it('story of a contract edge: proposal, lint, clarification, revision, acceptance of that task only', () => {
    const state = replay(repairLog);
    const g = buildGraph(state);
    const story = storyFor({ kind: 'edge', id: `contract:${BACKEND}` }, g, state, repairLog);
    expect(story.map((l) => l.slice(6))).toEqual(
      repairLog
        .filter((e) => e.task_id === BACKEND && /^(task_proposed|lint_reported|clarification_|contract_revised|task_accepted|task_rejected)/.test(e.type))
        .map((e) => storyFor({ kind: 'node', id: BACKEND }, g, state, [e])[0]!.slice(6)),
    );
    expect(story).toHaveLength(7); // proposed, lint, asked, answered, revised, lint, accepted
    expect(story.some((l) => /submits evidence|is stuck/.test(l))).toBe(false);
  });

  it('story of an evidence edge: evidence, checks, human review, repair and verification of that task only', () => {
    const state = replay(repairLog);
    const g = buildGraph(state);
    const story = storyFor({ kind: 'edge', id: `evidence:${BACKEND}` }, g, state, repairLog);
    const expected = repairLog.filter((e) => e.task_id === BACKEND && /^(evidence_|checks_|check_|human_review_recorded|repair_|task_verified)/.test(e.type));
    expect(story).toHaveLength(expected.length);
    expect(story.some((l) => /opens repair r1 for AC-2 only/.test(l))).toBe(true);
    expect(story.some((l) => /proposes|accepts v/.test(l))).toBe(false);
  });

  it('story of a question edge, a reply edge and an inbox item', () => {
    const { state, events } = replayUntil(repairLog, (e) => e.type === 'clarification_requested');
    const g = buildGraph(state);
    expect(storyFor({ kind: 'edge', id: `question:${BACKEND}` }, g, state, events)).toHaveLength(1);
    expect(storyFor({ kind: 'inbox', id: `task_question:${BACKEND}` }, g, state, events)).toEqual(
      storyFor({ kind: 'edge', id: `contract:${BACKEND}` }, g, state, events),
    );
    const final = replay(repairLog);
    const gf = buildGraph(final);
    const reply = storyFor({ kind: 'edge', id: `reply:${BACKEND}` }, gf, final, repairLog);
    expect(reply).toHaveLength(2); // the clarification answers and the AC-3 human review
    expect(reply[0]).toMatch(/you answer 2 questions for backend/);
    expect(reply[1]).toMatch(/you mark AC-3 passed/);
    const missionQ = replayUntil(live4, (e) => e.type === 'mission_clarification_answered');
    const gq = buildGraph(missionQ.state);
    expect(storyFor({ kind: 'edge', id: 'question:mission' }, gq, missionQ.state, missionQ.events)).toHaveLength(2);
  });

  it('is total: unknown refs and empty logs yield []', () => {
    const state = replay(live4);
    const g = buildGraph(state);
    expect(storyFor({ kind: 'node', id: 'nope' }, g, state, live4)).toEqual([]);
    expect(storyFor({ kind: 'edge', id: 'weird' }, g, state, live4)).toEqual([]);
    expect(storyFor({ kind: 'node', id: BACKEND }, g, state, [])).toEqual([]);
  });
});
