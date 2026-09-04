import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, formatTimestamp } from './cli.js';

interface Recorded { url: string; method: string; body?: unknown }

function fakeFetch(respond: (url: string, init?: RequestInit) => unknown) {
  const requests: Recorded[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const payload = respond(url, init);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));

describe('relay replay', () => {
  it('prints one timeline line per event: HH:MM:SS actor type task_id', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'events.jsonl');
    const events = [
      { seq: 1, ts: '2026-09-04T01:02:03.000Z', mission_id: 'm1', actor: 'human', type: 'mission_created', payload: { id: 'm1', repo: '/r', title: 'Login' } },
      { seq: 2, ts: '2026-09-04T01:02:04.500Z', mission_id: 'm1', task_id: 't-backend', actor: 'planner', type: 'task_proposed', payload: {} },
      { seq: 3, ts: '2026-09-04T01:02:09.000Z', mission_id: 'm1', task_id: 't-backend', actor: 'agent:backend', type: 'clarification_requested', payload: {} },
    ];
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n\n');
    const io = capture();

    const code = await run(['replay', file], io);

    expect(code).toBe(0);
    expect(io.out).toEqual([
      `${formatTimestamp(events[0]!.ts)} human mission_created -`,
      `${formatTimestamp(events[1]!.ts)} planner task_proposed t-backend`,
      `${formatTimestamp(events[2]!.ts)} agent:backend clarification_requested t-backend`,
    ]);
    expect(io.out).toHaveLength(3);
    expect(io.out[0]).toMatch(/^\d{2}:\d{2}:\d{2} human mission_created -$/);
  });

  it('fails with a message when the file is missing', async () => {
    const io = capture();
    expect(await run(['replay', path.join(tmpDir(), 'nope.jsonl')], io)).toBe(1);
    expect(io.err.join('\n')).toMatch(/nope\.jsonl/);
  });
});

describe('relay status', () => {
  const state = {
    last_seq: 9,
    missions: {},
    metrics: {},
    tasks: {
      't-backend': { id: 't-backend', runtime: 'working', task_state: 'executing', handoff_state: 'accepted', contract: { version: 2 } },
      't-frontend': { id: 't-frontend', runtime: 'unspawned', task_state: 'proposed', handoff_state: 'needs_clarification', contract: { version: 1 } },
    },
  };

  it('prints one line per task from GET /state', async () => {
    const { fetch, requests } = fakeFetch(() => state);
    const io = capture();

    const code = await run(['status'], { ...io, fetch, env: {} });

    expect(code).toBe(0);
    expect(requests).toEqual([{ url: 'http://127.0.0.1:7420/state', method: 'GET', body: undefined }]);
    expect(io.out).toEqual([
      't-backend working/executing/accepted v2',
      't-frontend unspawned/proposed/needs_clarification v1',
    ]);
  });

  it('honours RELAY_URL and --port', async () => {
    const a = fakeFetch(() => state);
    await run(['status'], { ...capture(), fetch: a.fetch, env: { RELAY_URL: 'http://relay.local:9999/' } });
    expect(a.requests[0]!.url).toBe('http://relay.local:9999/state');
    const b = fakeFetch(() => state);
    await run(['status', '--port', '7421'], { ...capture(), fetch: b.fetch, env: {} });
    expect(b.requests[0]!.url).toBe('http://127.0.0.1:7421/state');
  });

  it('reports HTTP errors and exits 1', async () => {
    const { fetch } = fakeFetch(() => new Response('boom', { status: 500 }));
    const io = capture();
    expect(await run(['status'], { ...io, fetch, env: {} })).toBe(1);
    expect(io.err.join('\n')).toMatch(/500/);
  });
});

describe('relay up', () => {
  it('posts the mission and prints its id', async () => {
    const { fetch, requests } = fakeFetch(() => ({ mission_id: 'm-42' }));
    const io = capture();

    const code = await run(['up', 'Add secure login to this application.', '--repo', '/work/demo'], { ...io, fetch, env: {} });

    expect(code).toBe(0);
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:7420/missions', method: 'POST', body: { repo: '/work/demo', title: 'Add secure login to this application.' } },
    ]);
    expect(io.out).toEqual(['m-42']);
  });

  it('--planner spawns an LLM planner after creating the mission', async () => {
    const { fetch, requests } = fakeFetch((url) => (url.endsWith('/planner') ? { pane_id: 'w1:p9' } : { mission_id: 'm-5' }));
    const io = capture();
    const code = await run(['up', 'Add secure login', '--repo', '/r', '--planner', 'claude-code'], { ...io, fetch, env: {} });
    expect(code).toBe(0);
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', 'http://127.0.0.1:7420/missions', { repo: '/r', title: 'Add secure login' }],
      ['POST', 'http://127.0.0.1:7420/missions/m-5/planner', { runtime: 'claude-code' }],
    ]);
    expect(io.out).toEqual(['m-5', 'planner (claude-code) spawned in pane w1:p9']);
    expect(await run(['up', 'T', '--planner', 'gemini'], { ...capture(), fetch, env: {} })).toBe(2);
  });

  it('defaults --repo to the cwd and forwards --host', async () => {
    const { fetch, requests } = fakeFetch(() => ({ mission_id: 'm-1' }));
    await run(['up', 'T', '--host', 'tmux'], { ...capture(), fetch, env: {}, cwd: '/here' });
    expect(requests[0]!.body).toEqual({ repo: '/here', title: 'T', host: 'tmux' });
  });

  it('loads a YAML plan and posts it to /missions/:id/plan', async () => {
    const dir = tmpDir();
    const plan = path.join(dir, 'plan.yaml');
    fs.writeFileSync(plan, `tasks:
  - id: t-backend
    recipient: backend
    runtime: claude-code
    goal: Add magic-link login
    scope:
      allowed_paths: ["src/auth/**"]
    acceptance_criteria:
      - id: AC-1
        condition: tests pass
        check: { kind: command, run: "npx vitest run src/auth" }
`);
    const { fetch, requests } = fakeFetch((url) => (url.endsWith('/plan') ? { task_ids: ['t-backend'] } : { mission_id: 'm-7' }));
    const io = capture();

    const code = await run(['up', 'Login', '--repo', '/r', '--plan', plan, '--port', '7500'], { ...io, fetch, env: {} });

    expect(code).toBe(0);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['POST', 'http://127.0.0.1:7500/missions'],
      ['POST', 'http://127.0.0.1:7500/missions/m-7/plan'],
    ]);
    const body = requests[1]!.body as { tasks: Array<Record<string, unknown>> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({ id: 't-backend', recipient: 'backend', runtime: 'claude-code', scope: { allowed_paths: ['src/auth/**'] } });
    expect(io.out[0]).toBe('m-7');
    expect(io.out.join('\n')).toContain('t-backend');
  });

  it('rejects an invalid plan before posting the mission', async () => {
    const dir = tmpDir();
    const plan = path.join(dir, 'bad.yaml');
    fs.writeFileSync(plan, 'tasks:\n  - id: not-valid\n');
    const { fetch, requests } = fakeFetch(() => ({ mission_id: 'm' }));
    const io = capture();
    expect(await run(['up', 'Login', '--plan', plan], { ...io, fetch, env: {} })).toBe(1);
    expect(requests).toHaveLength(0);
    expect(io.err.join('\n')).toMatch(/plan/i);
  });

  it('requires a title', async () => {
    const io = capture();
    expect(await run(['up'], { ...io, fetch: fakeFetch(() => ({})).fetch, env: {} })).toBe(2);
    expect(io.err.join('\n')).toMatch(/usage/i);
  });
});

describe('relay clarify / review / cancel', () => {
  it('clarify posts Qn=answer pairs', async () => {
    const { fetch, requests } = fakeFetch(() => ({ contract_version: 2 }));
    const io = capture();
    const code = await run(['clarify', 't-backend', 'Q1=magic link, 15 minutes', 'Q2=single use, no OAuth'], { ...io, fetch, env: {} });
    expect(code).toBe(0);
    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:7420/tasks/t-backend/clarify',
        method: 'POST',
        body: { answers: [{ question_id: 'Q1', answer: 'magic link, 15 minutes' }, { question_id: 'Q2', answer: 'single use, no OAuth' }] },
      },
    ]);
    expect(io.out.join('\n')).toContain('2');
  });

  it('clarify with a mission id posts to /missions/:id/clarify', async () => {
    const { fetch, requests } = fakeFetch(() => ({ answered: 1, open_questions: 0 }));
    const io = capture();
    const code = await run(['clarify', 'm-cd0a69', 'Q1=email magic link'], { ...io, fetch, env: {} });
    expect(code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:7420/missions/m-cd0a69/clarify', body: { answers: [{ question_id: 'Q1', answer: 'email magic link' }] } });
    expect(io.out).toEqual(['mission m-cd0a69: 1 answered, 0 open']);
  });

  it('reply posts a message to /tasks/:id/reply', async () => {
    const { fetch, requests } = fakeFetch(() => ({ delivered: true, unread: 1 }));
    const io = capture();
    expect(await run(['reply', 't-backend', 'use the memory sender'], { ...io, fetch, env: {} })).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:7420/tasks/t-backend/reply', body: { message: 'use the memory sender' } });
    expect(io.out).toEqual(['replied to t-backend (1 unread by the agent)']);
    expect(await run(['reply', 't-backend'], { ...capture(), fetch, env: {} })).toBe(2);
  });

  it('clarify rejects malformed answers', async () => {
    const { fetch, requests } = fakeFetch(() => ({}));
    const io = capture();
    expect(await run(['clarify', 't-backend', 'no-equals'], { ...io, fetch, env: {} })).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('review posts pass/fail with an optional observed failure', async () => {
    const { fetch, requests } = fakeFetch(() => ({ ok: true }));
    await run(['review', 't-backend', 'AC-2', 'fail', 'returns 200 for expired link'], { ...capture(), fetch, env: {} });
    await run(['review', 't-backend', 'AC-3', 'pass'], { ...capture(), fetch, env: {} });
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:7420/tasks/t-backend/review', method: 'POST', body: { criterion_id: 'AC-2', status: 'failed', observed_failure: 'returns 200 for expired link' } },
      { url: 'http://127.0.0.1:7420/tasks/t-backend/review', method: 'POST', body: { criterion_id: 'AC-3', status: 'passed' } },
    ]);
  });

  it('review rejects an unknown verdict', async () => {
    const { fetch, requests } = fakeFetch(() => ({ ok: true }));
    expect(await run(['review', 't-backend', 'AC-2', 'maybe'], { ...capture(), fetch, env: {} })).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('cancel posts an optional reason', async () => {
    const { fetch, requests } = fakeFetch(() => ({ ok: true }));
    await run(['cancel', 't-backend', 'scope changed'], { ...capture(), fetch, env: {} });
    await run(['cancel', 't-frontend'], { ...capture(), fetch, env: {} });
    expect(requests.map((r) => [r.url, r.body])).toEqual([
      ['http://127.0.0.1:7420/tasks/t-backend/cancel', { reason: 'scope changed' }],
      ['http://127.0.0.1:7420/tasks/t-frontend/cancel', {}],
    ]);
  });
});

describe('relay usage', () => {
  it('prints usage for unknown or missing commands', async () => {
    const io = capture();
    expect(await run([], io)).toBe(2);
    expect(await run(['frobnicate'], io)).toBe(2);
    expect(io.err.join('\n')).toMatch(/relay up/);
    const help = capture();
    expect(await run(['--help'], help)).toBe(0);
    expect(help.out.join('\n')).toMatch(/relay replay/);
  });
});
