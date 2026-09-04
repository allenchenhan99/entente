import { describe, it, expect } from 'vitest';
import type { Event } from '@relay/protocol';
import { createTestRelay, sampleContract } from '../fakes/test-harness.js';
import { createApp } from './app.js';

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function setup(opts: Parameters<typeof createTestRelay>[0] = {}) {
  const r = createTestRelay(opts);
  const app = createApp({ orchestrator: r.orchestrator, store: r.store, pingIntervalMs: 20 });
  return { ...r, app };
}

async function createMission(app: ReturnType<typeof createApp>) {
  const res = await app.request('/missions', json({ repo: '/repo', title: 'Add login' }));
  expect(res.status).toBe(200);
  return (await res.json()) as { mission_id: string; planner_token: string };
}

/** Reads SSE messages (blank-line separated blocks) until `count` blocks were seen, then aborts. */
async function readSse(res: Response, count: number, abort: AbortController): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const blocks: string[] = [];
  while (blocks.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      blocks.push(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  abort.abort();
  await reader.cancel().catch(() => {});
  return blocks;
}

describe('http', () => {
  it('GET /health and GET /state', async () => {
    const { app } = setup();
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: expect.any(String) });
    const state = await app.request('/state');
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ last_seq: 0, missions: {}, tasks: {} });
  });

  it('POST /missions validates the body and creates a mission', async () => {
    const { app, ofType } = setup();
    const bad = await app.request('/missions', json({ repo: '/repo' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ errors: [expect.stringContaining('title')] });
    const notJson = await app.request('/missions', { method: 'POST', body: 'nope' });
    expect(notJson.status).toBe(400);
    const { mission_id, planner_token } = await createMission(app);
    expect(mission_id).toMatch(/^m-[0-9a-f]{6}$/);
    expect(planner_token).toMatch(/^[0-9a-f]{32}$/);
    expect(ofType('mission_created')).toHaveLength(1);
    expect((await (await app.request('/state')).json()).last_seq).toBe(1);
  });

  it('POST /missions/:id/planner spawns a planner agent and validates runtime and mission', async () => {
    const { app, ofType } = setup();
    const { mission_id } = await createMission(app);
    const bad = await app.request(`/missions/${mission_id}/planner`, json({ runtime: 'gemini' }));
    expect(bad.status).toBe(400);
    const missing = await app.request('/missions/m-nope/planner', json({ runtime: 'codex' }));
    expect(missing.status).toBe(404);
    const ok = await app.request(`/missions/${mission_id}/planner`, json({ runtime: 'codex' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ pane_id: expect.any(String) });
    expect(ofType('agent_spawned')).toHaveLength(1);
  });

  it('POST /missions/:id/clarify answers open mission questions and rejects unknown ones', async () => {
    const { app, orchestrator, ofType } = setup();
    const { mission_id } = await createMission(app);
    orchestrator.askHuman(mission_id, [{ id: 'Q1', text: 'Which mechanism?', blocking: true }]);
    const bad = await app.request(`/missions/${mission_id}/clarify`, json({ answers: [{ question_id: 'Q7', answer: 'x' }] }));
    expect(bad.status).toBe(400);
    const ok = await app.request(`/missions/${mission_id}/clarify`, json({ answers: [{ question_id: 'Q1', answer: 'magic link' }] }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ answered: 1, open_questions: 0 });
    expect(ofType('mission_clarification_answered')).toHaveLength(1);
  });

  it('POST /missions/:id/plan loads 3 contracts, lints them and reports task ids', async () => {
    const { app, ofType, host } = setup();
    const { mission_id } = await createMission(app);
    const res = await app.request(`/missions/${mission_id}/plan`, json({
      tasks: [sampleContract('t-a'), sampleContract('t-b', { dependencies: ['t-a'] }), sampleContract('t-c', { acceptance_criteria: [] })],
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task_ids: ['t-a', 't-b', 't-c'] });
    expect(ofType('task_proposed').map((e) => e.actor)).toEqual(['human', 'human', 'human']);
    expect(ofType('lint_reported')).toHaveLength(3);
    expect(ofType('tasks_planned')[0].payload).toEqual({ task_ids: ['t-a', 't-b', 't-c'] });
    expect(host.calls.spawn.map((s) => s.name)).toEqual(['a']);
    expect((await app.request('/missions/m-nope/plan', json({ tasks: [] }))).status).toBe(404);
    const bad = await app.request(`/missions/${mission_id}/plan`, json({ tasks: [{ id: 'bad id' }] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it('GET /events/log?since= returns events after the cursor', async () => {
    const { app } = setup();
    await createMission(app);
    const all = (await (await app.request('/events/log')).json()) as Event[];
    expect(all.map((e) => e.seq)).toEqual([1]);
    const none = (await (await app.request('/events/log?since=1')).json()) as Event[];
    expect(none).toEqual([]);
    expect((await app.request('/events/log?since=x')).status).toBe(400);
  });

  it('POST /tasks/:id/reply delivers a message to a blocked agent', async () => {
    const { app, orchestrator, ofType } = setup();
    const { mission_id } = await createMission(app);
    await app.request(`/missions/${mission_id}/plan`, json({ tasks: [sampleContract('t-a')] }));
    orchestrator.respond('t-a', { contract_version: 1, decision: 'accepted', interpretation: ['a', 'b', 'c'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'x', 'AC-2': 'y' }, questions: [] });
    orchestrator.reportBlocker('t-a', { reason: 'need a decision', waiting_on: 'human' });
    const bad = await app.request('/tasks/t-a/reply', json({ message: '' }));
    expect(bad.status).toBe(400);
    const ok = await app.request('/tasks/t-a/reply', json({ message: 'go with option B' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ delivered: true, unread: 1 });
    expect(await orchestrator.awaitReply('t-a', 1)).toMatchObject({ status: 'replied', message: 'go with option B' });
    expect(ofType('blocker_replied')).toHaveLength(1);
    expect((await app.request('/tasks/t-nope/reply', json({ message: 'x' }))).status).toBe(404);
  });

  it('POST /tasks/:id/clarify, /review, /cancel behave per api.ts', async () => {
    const { app, orchestrator, ofType, host } = setup({ script: { 'AC-2': 'pending_human' } });
    const { mission_id } = await createMission(app);
    await app.request(`/missions/${mission_id}/plan`, json({ tasks: [sampleContract('t-a')] }));
    orchestrator.respond('t-a', {
      contract_version: 1, decision: 'needs_clarification', interpretation: [], assumptions: [], risks: [], verification_plan: {},
      questions: [{ id: 'Q1', text: 'Which auth?', blocking: true }],
    });
    expect((await app.request('/tasks/t-a/clarify', json({ answers: [] }))).status).toBe(400);
    expect((await app.request('/tasks/t-zzz/clarify', json({ answers: [{ question_id: 'Q1', answer: 'x' }] }))).status).toBe(404);
    const clarified = await app.request('/tasks/t-a/clarify', json({ answers: [{ question_id: 'Q1', answer: 'magic link' }] }));
    expect(clarified.status).toBe(200);
    expect(await clarified.json()).toEqual({ contract_version: 2 });
    expect(ofType('contract_revised')[0].payload.contract.constraints).toContain('Which auth?: magic link');

    // review needs pending evidence
    expect((await app.request('/tasks/t-a/review', json({ criterion_id: 'AC-2', status: 'failed' }))).status).toBe(409);
    orchestrator.respond('t-a', { contract_version: 2, decision: 'accepted', interpretation: ['x'], assumptions: [], risks: [], verification_plan: { 'AC-1': 'run it', 'AC-2': 'review' }, questions: [] });
    orchestrator.submitEvidence('t-a', { contract_version: 2, claimed: { 'AC-1': { status: 'passed' }, 'AC-2': { status: 'passed' } }, summary: 's' });
    await orchestrator.settled();
    expect((await app.request('/tasks/t-a/review', json({ criterion_id: 'AC-2', status: 'maybe' }))).status).toBe(400);
    const reviewed = await app.request('/tasks/t-a/review', json({ criterion_id: 'AC-2', status: 'failed', observed_failure: 'nope' }));
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toEqual({ ok: true });
    expect(ofType('repair_requested')).toHaveLength(1);

    expect((await app.request('/tasks/t-zzz/cancel', json({}))).status).toBe(404);
    const canceled = await app.request('/tasks/t-a/cancel', json({ reason: 'enough' }));
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({ ok: true });
    expect(ofType('task_canceled')[0].payload).toEqual({ reason: 'enough' });
    expect(host.calls.kill).toHaveLength(1);
  });

  it('SSE /events?since=0 replays existing events then streams new ones and pings', async () => {
    const { app, store } = setup();
    await createMission(app);
    const abort = new AbortController();
    const res = await app.request('/events?since=0', { signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    // append one more after the stream opened
    setTimeout(() => store.append({ mission_id: 'm-x', actor: 'relayd', type: 'mission_failed', payload: { reason: 'x' } }), 5);
    const blocks = await readSse(res, 3, abort);
    const messages = blocks.filter((b) => !b.startsWith(':'));
    const pings = blocks.filter((b) => b.startsWith(':'));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('event: relay');
    expect(messages[0]).toContain('id: 1');
    expect(JSON.parse(messages[0].split('\n').find((l) => l.startsWith('data:'))!.slice(5)).type).toBe('mission_created');
    expect(messages[1]).toContain('id: 2');
    expect(pings[0]).toBe(': ping');
    // a since cursor skips already-seen events
    const abort2 = new AbortController();
    const res2 = await app.request('/events?since=1', { signal: abort2.signal });
    const blocks2 = await readSse(res2, 1, abort2);
    expect(blocks2[0]).toContain('id: 2');
  });
});
