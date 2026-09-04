import { describe, it, expect, afterEach } from 'vitest';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RECIPIENT_TOOLS, PLANNER_TOOLS } from '@relay/protocol';
import { createTestRelay, sampleContract } from '../fakes/test-harness.js';
import { createApp } from '../http/app.js';

const servers: ServerType[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(opts: Parameters<typeof createTestRelay>[0] = {}) {
  const r = createTestRelay(opts);
  const app = createApp({ orchestrator: r.orchestrator, store: r.store });
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/mcp`;
  return { ...r, url };
}

async function connect(url: string, token?: string) {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
  await client.connect(transport);
  clients.push(client);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as Record<string, unknown> | undefined, text: (res.content as Array<{ text?: string }>)[0]?.text ?? '' };
};

const accepted = { contract_version: 1, decision: 'accepted', interpretation: ['Backend only'], verification_plan: { 'AC-1': 'run tests', 'AC-2': 'diff' } };
const claimedAll = { 'AC-1': { status: 'passed' }, 'AC-2': { status: 'passed' } };

describe('mcp happy path', () => {
  it('planner proposes, recipient accepts, submits evidence and gets verified', async () => {
    const r = await listen();
    const { mission_id, planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const planner = await connect(r.url, planner_token);
    const tools = (await planner.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...Object.values(RECIPIENT_TOOLS), ...Object.values(PLANNER_TOOLS)].sort());

    const mission = await call(planner, PLANNER_TOOLS.get_mission);
    expect(mission.isError).toBe(false);
    expect(mission.data).toMatchObject({ mission: { id: mission_id, title: 'Add login' }, status: 'planning', task_ids: [] });

    const proposed = await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    expect(proposed.isError).toBe(false);
    expect(proposed.data).toEqual({ status: 'proposed', task_id: 't-a', version: 1, warnings: [] });
    expect(r.host.calls.spawn).toHaveLength(1);
    const listed = await call(planner, PLANNER_TOOLS.list_tasks);
    expect((listed.data as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)).toEqual(['t-a']);

    const recipient = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    const contract = await call(recipient, RECIPIENT_TOOLS.get_contract);
    expect(contract.isError).toBe(false);
    expect(contract.data).toMatchObject({ contract: { id: 't-a', version: 1, mission_id }, worktree: { path: '/tmp/fake/t-a', branch: 'relay/t-a' } });
    expect(contract.data!.active_repair).toBeUndefined();

    const responded = await call(recipient, RECIPIENT_TOOLS.respond_to_contract, accepted);
    expect(responded.data).toEqual({ status: 'work_started', worktree: { path: '/tmp/fake/t-a', branch: 'relay/t-a' } });
    expect((await call(recipient, RECIPIENT_TOOLS.report_progress, { message: 'halfway', percent: 50 })).data).toEqual({ ok: true });

    const submitted = await call(recipient, RECIPIENT_TOOLS.submit_evidence, { contract_version: 1, claimed: claimedAll, summary: 'done' });
    expect(submitted.data).toEqual({ attempt: 1, checks_started: true });
    const verdict = await call(recipient, RECIPIENT_TOOLS.await_verdict, { attempt: 1, timeout_s: 5 });
    expect(verdict.data).toEqual({ status: 'verified' });

    const types = r.types();
    expect(types).toContain('task_verified');
    expect(types).toContain('task_completed');
    expect(types.indexOf('task_verified')).toBeLessThan(types.indexOf('task_completed'));
    expect(r.ofType('task_accepted')[0].actor).toBe('agent:a');
    expect(r.ofType('progress_reported')[0].payload).toEqual({ message: 'halfway', percent: 50 });
  });

  it('rejects unknown tokens and tokens of the wrong kind', async () => {
    const r = await listen();
    const { planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const anon = await connect(r.url);
    expect(await call(anon, PLANNER_TOOLS.list_tasks)).toMatchObject({ isError: true, text: expect.stringMatching(/token/i) });
    const bogus = await connect(r.url, 'deadbeef');
    expect((await call(bogus, RECIPIENT_TOOLS.get_contract)).isError).toBe(true);
    const planner = await connect(r.url, planner_token);
    expect(await call(planner, RECIPIENT_TOOLS.get_contract)).toMatchObject({ isError: true, text: expect.stringMatching(/recipient/i) });
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    const recipient = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    expect(await call(recipient, PLANNER_TOOLS.list_tasks)).toMatchObject({ isError: true, text: expect.stringMatching(/planner/i) });
    // invalid arguments are rejected by the zod input schema
    expect((await call(recipient, RECIPIENT_TOOLS.respond_to_contract, { decision: 'maybe' })).isError).toBe(true);
    // a lint error comes back as a normal (non-error) result the planner can act on
    const bad = await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-b', { acceptance_criteria: [] }) });
    expect(bad.isError).toBe(false);
    expect(bad.data).toMatchObject({ status: 'lint_error', task_id: 't-b' });
  });
});

describe('mcp clarification', () => {
  it('needs_clarification → HTTP clarify → concurrent await_contract resolves with revised v2', async () => {
    const r = await listen();
    const app = createApp({ orchestrator: r.orchestrator, store: r.store, withMcp: false });
    const { mission_id, planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const planner = await connect(r.url, planner_token);
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    const recipient = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    const waiting = await call(recipient, RECIPIENT_TOOLS.respond_to_contract, {
      contract_version: 1, decision: 'needs_clarification',
      questions: [{ id: 'Q1', text: 'Which auth method?' }, { id: 'Q2', text: 'Link TTL?' }],
    });
    expect(waiting.data).toEqual({ status: 'waiting', open_questions: 2 });
    expect(r.types().at(-1)).toBe('clarification_requested');

    const pending = await call(recipient, RECIPIENT_TOOLS.await_contract, { since_version: 1, timeout_s: 1 });
    expect(pending.data).toEqual({ status: 'pending' });

    const poll = call(recipient, RECIPIENT_TOOLS.await_contract, { since_version: 1, timeout_s: 10 });
    await new Promise((res) => setTimeout(res, 50));
    const clarified = await app.request('/tasks/t-a/clarify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ question_id: 'Q1', answer: 'magic link' }, { question_id: 'Q2', answer: '15 minutes' }] }),
    });
    expect(await clarified.json()).toEqual({ contract_version: 2 });
    const revised = await poll;
    expect(revised.data).toMatchObject({ status: 'revised', contract: { version: 2, mission_id } });
    const v2 = (revised.data as { contract: { clarifications: unknown[]; constraints: string[] } }).contract;
    expect(v2.clarifications).toHaveLength(2);
    expect(v2.constraints).toHaveLength(sampleContract('t-a').constraints!.length + 2);
    expect(r.ofType('contract_revised')[0].payload.contract.version).toBe(2);
    expect((await call(recipient, RECIPIENT_TOOLS.respond_to_contract, { ...accepted, contract_version: 2 })).data).toMatchObject({ status: 'work_started' });
  });

  it('planner can answer a clarification over MCP', async () => {
    const r = await listen();
    const { planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const planner = await connect(r.url, planner_token);
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    const recipient = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    await call(recipient, RECIPIENT_TOOLS.respond_to_contract, { contract_version: 1, decision: 'needs_clarification', questions: [{ id: 'Q1', text: 'Which auth?' }] });
    const answered = await call(planner, PLANNER_TOOLS.answer_clarification, { task_id: 't-a', answers: [{ question_id: 'Q1', answer: 'magic link' }] });
    expect(answered.data).toEqual({ contract_version: 2 });
    expect(r.ofType('clarification_answered')[0].actor).toBe('planner');
    const revised = await call(planner, PLANNER_TOOLS.revise_task, { task_id: 't-a', patch: { goal: 'Implement magic-link auth' } });
    expect(revised.data).toEqual({ contract_version: 3 });
    expect((await call(recipient, RECIPIENT_TOOLS.get_contract)).data).toMatchObject({ contract: { version: 3, goal: 'Implement magic-link auth' } });
  });
});

describe('mcp repair path', () => {
  it('mismatch → repair → get_contract carries active_repair → resubmit → verified; budget 0 → failed_budget', async () => {
    const r = await listen({ script: { 'AC-1': 'passed', 'AC-2': 'failed' } });
    const { planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const planner = await connect(r.url, planner_token);
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-b', { budget: { max_repairs: 0 } }) });
    const a = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    await call(a, RECIPIENT_TOOLS.respond_to_contract, accepted);
    await call(a, RECIPIENT_TOOLS.submit_evidence, { contract_version: 1, claimed: claimedAll, summary: 'first' });
    const verdict = await call(a, RECIPIENT_TOOLS.await_verdict, { attempt: 1, timeout_s: 5 });
    expect(verdict.data).toMatchObject({ status: 'repair', repair: { failed_criteria: ['AC-2'], attempt: 2 } });
    expect(r.ofType('evidence_recorded')[0].payload.record.self_report_mismatch).toEqual(['AC-2']);
    expect(r.ofType('repair_requested')[0].payload.repair.failed_criteria).toEqual(['AC-2']);
    const contract = await call(a, RECIPIENT_TOOLS.get_contract);
    expect((contract.data as { active_repair: { id: string } }).active_repair.id).toBe('t-a/r1');
    expect(r.ofType('repair_accepted')).toHaveLength(1);

    r.checks.script = {};
    expect((await call(a, RECIPIENT_TOOLS.submit_evidence, { contract_version: 1, claimed: claimedAll, summary: 'second' })).data).toEqual({ attempt: 2, checks_started: true });
    expect((await call(a, RECIPIENT_TOOLS.await_verdict, { attempt: 2, timeout_s: 5 })).data).toEqual({ status: 'verified' });

    r.checks.script = { 'AC-2': 'failed' };
    const b = await connect(r.url, r.orchestrator.tokenFor('t-b'));
    await call(b, RECIPIENT_TOOLS.respond_to_contract, accepted);
    await call(b, RECIPIENT_TOOLS.submit_evidence, { contract_version: 1, claimed: claimedAll, summary: 'b' });
    expect((await call(b, RECIPIENT_TOOLS.await_verdict, { attempt: 1, timeout_s: 5 })).data).toMatchObject({ status: 'failed_budget' });
    expect(r.ofType('task_failed_budget').map((e) => e.task_id)).toEqual(['t-b']);
  });

  it('report_blocker → HTTP-side reply → await_reply delivers the message without unblocking', async () => {
    const r = await listen();
    const { planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const planner = await connect(r.url, planner_token);
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    const a = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    await call(a, RECIPIENT_TOOLS.respond_to_contract, accepted);
    await call(a, RECIPIENT_TOOLS.report_blocker, { reason: 'which sender?', waiting_on: 'human' });
    const waiting = call(a, RECIPIENT_TOOLS.await_reply, { timeout_s: 5 });
    r.orchestrator.reply('t-a', 'use MemoryEmailSender', 'human');
    expect((await waiting).data).toMatchObject({ status: 'replied', message: 'use MemoryEmailSender', replied_by: 'human' });
    expect(r.orchestrator.taskView('t-a')!.runtime).toBe('blocked');
    expect((await call(a, RECIPIENT_TOOLS.await_reply, { timeout_s: 1 })).data).toEqual({ status: 'pending' });
  });

  it('report_blocker then any tool call unblocks', async () => {
    const r = await listen();
    const { planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const planner = await connect(r.url, planner_token);
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    const a = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    await call(a, RECIPIENT_TOOLS.respond_to_contract, accepted);
    expect((await call(a, RECIPIENT_TOOLS.report_blocker, { reason: 'waiting for schema', waiting_on: 't-schema' })).data).toEqual({ ok: true });
    await call(a, RECIPIENT_TOOLS.await_verdict, { attempt: 1, timeout_s: 1 });
    expect(r.types().at(-1)).toBe('task_blocked');
    await call(a, RECIPIENT_TOOLS.report_progress, { message: 'unblocked' });
    expect(r.types().slice(-2)).toEqual(['task_unblocked', 'progress_reported']);
  });
});

describe('mcp subtask (agent networking)', () => {
  it('recipient proposes a subtask, the child accepts and submits, the parent\'s await_task resolves completed without a heartbeat', async () => {
    const r = await listen();
    const { mission_id, planner_token } = r.orchestrator.createMission({ repo: '/repo', title: 'Add login' });
    const planner = await connect(r.url, planner_token);
    await call(planner, PLANNER_TOOLS.propose_task, { contract: sampleContract('t-a') });
    const parent = await connect(r.url, r.orchestrator.tokenFor('t-a'));
    await call(parent, RECIPIENT_TOOLS.respond_to_contract, accepted);

    // the planner token cannot delegate; a recipient can
    expect(await call(planner, RECIPIENT_TOOLS.propose_subtask, { contract: sampleContract('t-a-schema') })).toMatchObject({ isError: true, text: expect.stringMatching(/recipient/i) });
    const proposed = await call(parent, RECIPIENT_TOOLS.propose_subtask, { contract: sampleContract('t-a-schema') });
    expect(proposed.isError).toBe(false);
    expect(proposed.data).toEqual({ status: 'proposed', task_id: 't-a-schema', version: 1, warnings: [] });
    expect(r.ofType('task_proposed').at(-1)).toMatchObject({ actor: 'agent:a', task_id: 't-a-schema', payload: { contract: { parent_task: 't-a', sender: 'agent:a', mission_id } } });
    expect(r.host.calls.spawn.map((s) => s.name)).toEqual(['a', 'a-schema']);
    // overlap with the parent and a cycle are rejected
    expect((await call(parent, RECIPIENT_TOOLS.propose_subtask, { contract: sampleContract('t-a-x', { scope: { allowed_paths: ['src/t-a/x/**'] } }) })).data)
      .toMatchObject({ status: 'lint_error', errors: [expect.stringMatching(/^overlapping_scope/)] });
    expect(await call(parent, RECIPIENT_TOOLS.propose_subtask, { contract: sampleContract('t-a-y', { dependencies: ['t-a'] }) })).toMatchObject({ isError: true, text: expect.stringMatching(/cycle/) });
    // the planner and the human see the subtask exactly like a planned task
    const listed = await call(planner, PLANNER_TOOLS.list_tasks);
    expect((listed.data as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id)).toEqual(['t-a', 't-a-schema']);

    expect(await call(parent, RECIPIENT_TOOLS.await_task, { task_id: 't-a', timeout_s: 1 })).toMatchObject({ isError: true, text: expect.stringMatching(/itself/) });
    expect((await call(parent, RECIPIENT_TOOLS.await_task, { task_id: 't-a-schema', timeout_s: 1 })).data)
      .toEqual({ status: 'pending', task_id: 't-a-schema', task_state: 'proposed', handoff_state: 'proposed' });

    const before = r.orchestrator.taskView('t-a')!;
    expect(before.runtime).toBe('working');
    const parentEventsBefore = r.store.all().filter((e) => e.task_id === 't-a').length;
    const waiting = call(parent, RECIPIENT_TOOLS.await_task, { task_id: 't-a-schema', timeout_s: 10 });

    const child = await connect(r.url, r.orchestrator.tokenFor('t-a-schema'));
    expect((await call(child, RECIPIENT_TOOLS.get_contract)).data).toMatchObject({ contract: { id: 't-a-schema', parent_task: 't-a' }, worktree: { branch: 'relay/t-a-schema' } });
    expect((await call(child, RECIPIENT_TOOLS.respond_to_contract, accepted)).data).toMatchObject({ status: 'work_started' });
    expect((await call(child, RECIPIENT_TOOLS.submit_evidence, { contract_version: 1, claimed: claimedAll, summary: 'schema' })).data).toEqual({ attempt: 1, checks_started: true });
    expect((await call(child, RECIPIENT_TOOLS.await_verdict, { attempt: 1, timeout_s: 5 })).data).toEqual({ status: 'verified' });

    expect((await waiting).data).toEqual({ status: 'completed', task_id: 't-a-schema', branch: 'relay/t-a-schema' });
    // await_task is not a heartbeat: the parent's runtime state and its event stream are untouched by the call
    const after = r.orchestrator.taskView('t-a')!;
    expect(after.runtime).toBe('working');
    expect(after.last_seen_at).toBe(before.last_seen_at);
    expect(r.store.all().filter((e) => e.task_id === 't-a').length).toBe(parentEventsBefore);
    expect(r.types()).not.toContain('tasks_planned');
  });
});
