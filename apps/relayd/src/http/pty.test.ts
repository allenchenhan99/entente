import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { HostMetrics, PaneInfo } from '@relay/protocol';
import { createSessionAuth, type SessionAuth } from '../auth/token.js';
import { createRelayHost, type RelayHost } from '../pty/host.js';
import { mountPty } from './pty.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function setup(auth?: SessionAuth): { app: Hono; host: RelayHost; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const host = createRelayHost({ relayDir: path.join(dir, '.relay'), runId: 'run-1', timings: { quietMs: 100, retryMs: 300, timeoutMs: 3000 } });
  const app = new Hono();
  mountPty(app, host, auth ? { auth } : {});
  cleanups.push(async () => { await host.killAll(50); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, host, dir };
}
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('GET /metrics', () => {
  it('returns HostMetrics counting every spawn, only live panes as alive, with per-pane timings', async () => {
    const { app, host, dir } = setup();
    const empty = await app.request('/metrics');
    expect(empty.status).toBe(200);
    expect(HostMetrics.parse(await empty.json())).toMatchObject({ host: 'relay', panes_spawned: 0, panes_alive: 0, prompt_failures: 0, panes: [] });

    const gone = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'echo bye; exit 0'], env: {} });
    const live = await host.spawn({ name: 'planner', cwd: dir, argv: ['sh', '-c', 'read x'], env: {} });
    await host.get(gone.paneId)!.exited;

    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const metrics = HostMetrics.parse(await res.json());
    expect(metrics).toMatchObject({ host: 'relay', panes_spawned: 2, panes_alive: 1, prompt_failures: 0 });
    expect(metrics.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.panes.map((p) => p.pane_id)).toEqual([gone.paneId, live.paneId]);
    expect(metrics.panes[0]!.timings.spawn_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.panes[0]!.timings.output_bytes).toBeGreaterThan(0);
  });

  it('GET /panes/:id carries timings', async () => {
    const { app, host, dir } = setup();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'echo hi; read x'], env: {} });
    await host.get(paneId)!.firstOutput;
    const res = await app.request(`/panes/${paneId}`);
    expect(res.status).toBe(200);
    const info = PaneInfo.parse(await res.json());
    expect(info.timings).toBeDefined();
    expect(info.timings!.spawn_ms).toBeGreaterThanOrEqual(0);
    expect(info.timings!.first_output_ms).toBeGreaterThanOrEqual(0);
    expect(info.timings!.output_chunks).toBeGreaterThanOrEqual(1);
  });

  it('is 401 without the session token when auth is configured, 200 with it', async () => {
    const auth = createSessionAuth({ relayDir: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')), mode: 'optional' });
    const { app } = setup(auth);
    expect((await app.request('/metrics')).status).toBe(401);
    expect((await app.request('/metrics', bearer('f'.repeat(32)))).status).toBe(401);
    const ok = await app.request('/metrics', bearer(auth.token));
    expect(ok.status).toBe(200);
    expect(HostMetrics.parse(await ok.json()).host).toBe('relay');
  });
});
