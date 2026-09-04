import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '@relay/protocol';
import type { Graph, GraphApi } from '@relay/protocol';
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

const emptyGraph = (): Graph => ({ nodes: [], edges: [], inbox: [] });

function fakeGraphApi(overrides: Partial<GraphApi> = {}): GraphApi {
  return {
    buildGraph: emptyGraph,
    actionsFor: () => [],
    narrate: (event) => `${event.actor} ${event.type}`,
    storyFor: () => [],
    describe: (ref) => ({ title: ref.id, lines: [] }),
    ...overrides,
  };
}

const paneInfo = (overrides: Record<string, unknown> = {}) => ({
  pane_id: 'relay:7',
  task_id: 't-backend',
  role: 'backend',
  runtime: 'codex',
  cwd: '/work/backend',
  pid: 4242,
  alive: true,
  cols: 120,
  rows: 40,
  cast_path: '/run/casts/relay-7.cast',
  started_at: '2026-09-04T08:00:00.000Z',
  exited_at: '2026-09-04T09:00:00.000Z',
  exit_code: 0,
  ...overrides,
});

describe('relay pane list', () => {
  it('renders a table with two validated panes and marks the focused pane', async () => {
    const panes = [
      paneInfo({ focused: true }),
      paneInfo({
        pane_id: 'relay:8',
        task_id: undefined,
        role: 'planner',
        runtime: 'claude-code',
        cwd: '/work',
        pid: 4343,
        alive: false,
        cols: 80,
        rows: 24,
        cast_path: undefined,
        exited_at: undefined,
        exit_code: undefined,
      }),
    ];
    const { fetch, requests } = fakeFetch(() => panes);
    const io = capture();

    expect(await run(['pane', 'list', '--port', '7500'], { ...io, fetch, env: {} })).toBe(0);
    expect(requests).toEqual([{ url: 'http://127.0.0.1:7500/panes', method: 'GET', body: undefined }]);
    expect(io.out).toEqual([
      '  pane_id  role     task_id    alive  cols×rows  cwd',
      '* relay:7  backend  t-backend  true   120×40     /work/backend',
      '  relay:8  planner  -          false  80×24      /work',
    ]);
  });

  it('fails clearly when a pane does not match PaneInfo', async () => {
    const { fetch } = fakeFetch(() => [paneInfo({ cols: 0 })]);
    const io = capture();

    expect(await run(['pane', 'list'], { ...io, fetch, env: {} })).toBe(1);
    expect(io.err.join('\n')).toContain('response does not match PaneInfo[]');
    expect(io.err.join('\n')).toContain('cols');
  });
});

describe('relay pane get', () => {
  it('prints every PaneInfo field as key/value lines', async () => {
    const { fetch, requests } = fakeFetch(() => paneInfo());
    const io = capture();

    expect(await run(['pane', 'get', 'relay:7'], { ...io, fetch, env: {} })).toBe(0);
    expect(requests[0]).toMatchObject({ url: 'http://127.0.0.1:7420/panes/relay:7', method: 'GET' });
    expect(io.out).toEqual([
      'pane_id: relay:7',
      'task_id: t-backend',
      'role: backend',
      'runtime: codex',
      'cwd: /work/backend',
      'pid: 4242',
      'alive: true',
      'cols: 120',
      'rows: 40',
      'cast_path: /run/casts/relay-7.cast',
      'started_at: 2026-09-04T08:00:00.000Z',
      'exited_at: 2026-09-04T09:00:00.000Z',
      'exit_code: 0',
    ]);
  });
});

describe('relay pane read', () => {
  it('prints snapshot lines verbatim and forwards source and lines', async () => {
    const snapshot = {
      pane_id: 'relay:7',
      cols: 120,
      rows: 40,
      lines: ['first line  ', '', 'prompt> npm test'],
      cursor: { x: 16, y: 2 },
      alternate: false,
      scrollback_lines: 300,
    };
    const { fetch, requests } = fakeFetch(() => snapshot);
    const io = capture();

    expect(await run(['pane', 'read', 'relay:7', '--source', 'recent', '--lines', '50'], { ...io, fetch, env: {} })).toBe(0);
    expect(requests[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/panes/relay:7/screen?source=recent&lines=50',
      method: 'GET',
    });
    expect(io.out).toEqual(snapshot.lines);
  });

  it('fails clearly when the response does not match ScreenSnapshot', async () => {
    const { fetch } = fakeFetch(() => ({ pane_id: 'relay:7', lines: ['incomplete'] }));
    const io = capture();

    expect(await run(['pane', 'read', 'relay:7'], { ...io, fetch, env: {} })).toBe(1);
    expect(io.err.join('\n')).toContain('response does not match ScreenSnapshot');
  });
});

describe('relay pane input', () => {
  it('posts text and comma-separated logical keys in PaneInputBody', async () => {
    const { fetch, requests } = fakeFetch(() => ({ ok: true }));
    const io = capture();

    expect(await run(['pane', 'input', 'relay:7', '--text', 'continue', '--keys', 'enter,ctrl+c'], { ...io, fetch, env: {} })).toBe(0);
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:7420/panes/relay:7/input',
      method: 'POST',
      body: { text: 'continue', keys: ['enter', 'ctrl+c'] },
    }]);
    expect(io.out).toEqual(['ok']);
  });

  it('rejects a call with neither text nor keys without fetching', async () => {
    const { fetch, requests } = fakeFetch(() => ({ ok: true }));
    const io = capture();

    expect(await run(['pane', 'input', 'relay:7'], { ...io, fetch, env: {} })).toBe(2);
    expect(requests).toHaveLength(0);
    expect(io.err.join('\n')).toContain('at least one of --text or --keys');
  });
});

describe('relay pane run', () => {
  it('types the command followed by enter', async () => {
    const { fetch, requests } = fakeFetch(() => ({ ok: true }));
    const io = capture();

    expect(await run(['pane', 'run', 'relay:7', 'npx vitest run'], { ...io, fetch, env: {} })).toBe(0);
    expect(requests[0]).toEqual({
      url: 'http://127.0.0.1:7420/panes/relay:7/input',
      method: 'POST',
      body: { text: 'npx vitest run', keys: ['enter'] },
    });
    expect(io.out).toEqual(['ok']);
  });
});

describe('relay inbox', () => {
  it('prints one block per item with the exact command to act', async () => {
    const graph: Graph = {
      nodes: [],
      edges: [],
      inbox: [
        {
          id: 'inbox:questions:t-a',
          kind: 'task_question',
          mission_id: 'm-1',
          task_id: 't-a',
          title: 'backend asks 2 questions (v1)',
          detail: ['Q1: Which authentication method?', 'Q2: How long should links last?'],
          ref: { kind: 'edge', id: 'contract:t-a' },
          actions: [
            { key: 'Enter', label: 'inspect', kind: 'inspect', target: { task_id: 't-a' } },
            { key: 'a', label: 'answer', kind: 'clarify', target: { task_id: 't-a', question_ids: ['Q1', 'Q2'] } },
          ],
        },
        {
          id: 'inbox:review:t-a:AC-3',
          kind: 'human_review',
          mission_id: 'm-1',
          task_id: 't-a',
          title: 'AC-3 needs human review',
          detail: ['A link cannot be reused'],
          ref: { kind: 'edge', id: 'evidence:t-a' },
          actions: [{ key: 'p', label: 'review', kind: 'review', target: { task_id: 't-a', criterion_id: 'AC-3' } }],
        },
      ],
    };
    const state = initialState();
    const { fetch, requests } = fakeFetch((url) => (url.includes('/events/log') ? [] : state));
    const io = capture();

    const code = await run(['inbox'], { ...io, fetch, env: {}, graph: fakeGraphApi({ buildGraph: () => graph }) });

    expect(code).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:7420/state',
      'http://127.0.0.1:7420/events/log?since=0',
    ]);
    expect(io.out).toEqual([
      '[task_question] backend asks 2 questions (v1)',
      '  Q1: Which authentication method?',
      '  Q2: How long should links last?',
      '→ relay clarify t-a Q1="…" Q2="…"',
      '',
      '[human_review] AC-3 needs human review',
      '  A link cannot be reused',
      '→ relay review t-a AC-3 pass|fail',
    ]);
  });

  it('prints the empty message when nothing needs attention', async () => {
    const { fetch } = fakeFetch((url) => (url.includes('/events/log') ? [] : initialState()));
    const io = capture();

    expect(await run(['inbox'], { ...io, fetch, env: {}, graph: fakeGraphApi() })).toBe(0);
    expect(io.out).toEqual(['inbox empty — nothing needs you']);
  });

  it('replays a JSONL file without calling fetch', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({
      seq: 1,
      ts: '2026-09-04T01:02:03.000Z',
      mission_id: 'm-1',
      actor: 'human',
      type: 'mission_created',
      payload: { id: 'm-1', repo: '/r', title: 'Login' },
    })}\n`);
    let fetchCalls = 0;
    const fetch = (async () => {
      fetchCalls += 1;
      throw new Error('fetch must not be called in replay mode');
    }) as typeof globalThis.fetch;
    const io = capture();

    expect(await run(['inbox', '--replay', file], { ...io, fetch, env: {}, graph: fakeGraphApi() })).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(io.out).toEqual(['inbox empty — nothing needs you']);
  });
});

describe('relay explain', () => {
  const graph: Graph = {
    nodes: [
      { id: 'human', kind: 'human', label: 'human', column: 0, status: 'pending' },
      { id: 'planner', kind: 'planner', label: 'planner', column: 0, status: 'done' },
      { id: 't-a', kind: 'agent', label: 'backend', task_id: 't-a', column: 1, status: 'working' },
      { id: 'verifier', kind: 'verifier', label: 'verifier', column: 2, status: 'pending' },
    ],
    edges: [
      { id: 'contract:t-a', kind: 'contract', from: 'planner', to: 't-a', task_id: 't-a', label: 'v1', status: 'done', attention: false },
      { id: 'evidence:t-a', kind: 'evidence', from: 't-a', to: 'verifier', task_id: 't-a', label: 'awaiting evidence', status: 'pending', attention: false },
    ],
    inbox: [
      {
        id: 'inbox:blocker:t-a',
        kind: 'blocker',
        mission_id: 'm-1',
        task_id: 't-a',
        title: 'backend is blocked',
        detail: ['Needs a product decision'],
        ref: { kind: 'node', id: 't-a' },
        actions: [{ key: 'r', label: 'reply', kind: 'reply', target: { task_id: 't-a' } }],
      },
    ],
  };

  it('prints describe, a blank line, then storyFor for a task ref', async () => {
    const event = {
      seq: 1,
      ts: '2026-09-04T01:02:03.000Z',
      mission_id: 'm-1',
      actor: 'human' as const,
      type: 'mission_created' as const,
      payload: { id: 'm-1', repo: '/r', title: 'Login', success_definition: '', integration_check: 'npx vitest run', budget: { max_repairs_per_task: 3 } },
    };
    const state = initialState();
    const { fetch } = fakeFetch((url) => (url.includes('/events/log') ? [event] : state));
    const io = capture();
    const graphApi = fakeGraphApi({
      buildGraph: () => graph,
      describe: (ref) => ({ title: `${ref.id} — backend agent`, lines: ['runtime: working', 'contract: v1 accepted'] }),
      storyFor: (ref, _graph, _state, events) => [`${ref.id} accepted its contract`, `${[...events].length} event considered`],
    });

    const code = await run(['explain', 't-a'], { ...io, fetch, env: {}, graph: graphApi });

    expect(code).toBe(0);
    expect(io.out).toEqual([
      't-a — backend agent',
      'runtime: working',
      'contract: v1 accepted',
      '',
      't-a accepted its contract',
      '1 event considered',
    ]);
  });

  it('exits 2 for an unknown ref and lists every valid ref', async () => {
    const { fetch } = fakeFetch((url) => (url.includes('/events/log') ? [] : initialState()));
    const io = capture();

    const code = await run(['explain', 'nope'], { ...io, fetch, env: {}, graph: fakeGraphApi({ buildGraph: () => graph }) });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('unknown object: nope');
    expect(io.err.join('\n')).toContain('valid refs: contract:t-a, evidence:t-a, human, inbox:blocker:t-a, planner, t-a, verifier');
  });

  it('prints nothing to show when the graph implementation has no objects yet', async () => {
    const { fetch } = fakeFetch((url) => (url.includes('/events/log') ? [] : initialState()));
    const io = capture();

    const code = await run(['explain', 't-a'], { ...io, fetch, env: {}, graph: fakeGraphApi() });

    expect(code).toBe(0);
    expect(io.out).toEqual(['explain empty — nothing to show']);
  });

  it('still rejects an invalid ref when the graph implementation is empty', async () => {
    const { fetch } = fakeFetch((url) => (url.includes('/events/log') ? [] : initialState()));
    const io = capture();

    const code = await run(['explain', 'nope'], { ...io, fetch, env: {}, graph: fakeGraphApi() });

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('unknown object: nope');
    expect(io.err.join('\n')).toContain('valid refs: (none)');
  });
});

describe('relay story', () => {
  it('narrates only the selected task events with HH:MM prefixes', async () => {
    const events = [
      { seq: 1, ts: '2026-09-04T01:02:03.000Z', mission_id: 'm-1', task_id: 't-a', actor: 'agent:backend', type: 'progress_reported', payload: { message: 'started' } },
      { seq: 2, ts: '2026-09-04T01:03:03.000Z', mission_id: 'm-1', task_id: 't-b', actor: 'agent:frontend', type: 'progress_reported', payload: { message: 'unrelated' } },
      { seq: 3, ts: '2026-09-04T01:04:03.000Z', mission_id: 'm-1', task_id: 't-a', actor: 'agent:backend', type: 'task_blocked', payload: { reason: 'needs decision' } },
    ];
    const { fetch } = fakeFetch((url) => (url.includes('/events/log') ? events : initialState()));
    const narrated: number[] = [];
    const graph = fakeGraphApi({
      narrate: (event) => {
        narrated.push(event.seq);
        return `event ${event.seq} for ${event.task_id}`;
      },
    });
    const io = capture();

    const code = await run(['story', '--task', 't-a'], { ...io, fetch, env: {}, graph });

    expect(code).toBe(0);
    expect(narrated).toEqual([1, 3]);
    expect(io.out).toEqual([
      `${formatTimestamp(events[0]!.ts).slice(0, 5)}  event 1 for t-a`,
      `${formatTimestamp(events[2]!.ts).slice(0, 5)}  event 3 for t-a`,
    ]);
    expect(io.out.every((line) => /^\d{2}:\d{2}  /.test(line))).toBe(true);
  });

  it('prints a clear message when there are no events to narrate', async () => {
    const { fetch } = fakeFetch((url) => (url.includes('/events/log') ? [] : initialState()));
    const io = capture();

    expect(await run(['story'], { ...io, fetch, env: {}, graph: fakeGraphApi() })).toBe(0);
    expect(io.out).toEqual(['story empty — nothing to show']);
  });
});

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
    expect(help.out.join('\n')).toContain('relay inbox');
    expect(help.out.join('\n')).toContain('relay explain <object>');
    expect(help.out.join('\n')).toContain('relay story');
  });
});
