import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, initialState } from '@relay/protocol';
import { createTestRelay } from '../fakes/test-harness.js';
import { createSessionAuth } from '../auth/token.js';
import { createApp } from './app.js';

const FIXTURES_DIR = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

/** A relayd app whose store was opened on the first `lines` events of a fixture (all of them by default). */
function setup(fixture?: string, opts: { lines?: number; auth?: 'optional' | 'required' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  if (fixture) {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf8').split('\n').filter((l) => l.trim());
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'run', 'events.jsonl'), text.slice(0, opts.lines ?? text.length).join('\n') + '\n');
  }
  const r = createTestRelay({ dir });
  const auth = opts.auth ? createSessionAuth({ relayDir: path.join(dir, '.relay'), mode: opts.auth }) : undefined;
  const app = createApp({ orchestrator: r.orchestrator, store: r.store, withMcp: false, auth });
  return { ...r, app, auth };
}

const get = async (app: ReturnType<typeof createApp>, url: string) => {
  const res = await app.request(url);
  return { status: res.status, body: (await res.json()) as any };
};

describe('GET /graph', () => {
  it('returns buildGraph(state) plus the last event seq for the live-1 fixture', async () => {
    const { app, store } = setup('events-live-1.jsonl');
    const { status, body } = await get(app, '/graph');
    expect(status).toBe(200);
    const graph = buildGraph(store.state());
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(body).toEqual({ ...JSON.parse(JSON.stringify(graph)), seq: store.state().last_seq });
    expect(body.seq).toBe(store.all().at(-1)!.seq);
  });

  it('returns the empty graph with seq 0 on an empty store', async () => {
    const { app } = setup();
    const { status, body } = await get(app, '/graph');
    expect(status).toBe(200);
    expect(body).toEqual({ ...buildGraph(initialState()), seq: 0 });
  });
});
