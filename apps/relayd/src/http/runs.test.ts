import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import type { Event, ScreenSnapshot } from '@relay/protocol';
import { CastRecorder } from '../pty/recorder.js';
import { mountRuns } from './runs.js';

const directories: string[] = [];

async function setupRuns(): Promise<{ app: Hono; castPath: string; relayDir: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  directories.push(root);
  const relayDir = path.join(root, '.relay');
  const runDir = path.join(relayDir, 'runs', 'run-1');
  const castPath = path.join(runDir, 'casts', 'relay:7.cast');
  fs.mkdirSync(runDir, { recursive: true });
  const events: Event[] = [
    {
      seq: 1,
      ts: '2026-09-04T10:00:00.000Z',
      mission_id: 'm-1',
      actor: 'human',
      type: 'mission_created',
      payload: { id: 'm-1', repo: root, title: 'Replay this run' },
    },
    {
      seq: 2,
      ts: '2026-09-04T10:00:01.000Z',
      mission_id: 'm-1',
      actor: 'planner',
      type: 'tasks_planned',
      payload: { task_ids: ['t-backend'] },
    },
    {
      seq: 3,
      ts: '2026-09-04T10:00:02.000Z',
      mission_id: 'm-1',
      task_id: 't-backend',
      actor: 'agent:backend',
      type: 'progress_reported',
      payload: { message: 'done' },
    },
  ];
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  let now = 0;
  const recorder = new CastRecorder({ path: castPath, cols: 20, rows: 5, title: 'backend', timestamp: 1_788_458_400, now: () => now });
  now = 1_000;
  recorder.output('hello');
  now = 2_000;
  recorder.output('\x1b[2J');
  await recorder.close();

  const app = new Hono();
  mountRuns(app, { relayDir });
  return { app, castPath, relayDir };
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runs HTTP routes', () => {
  it('lists recorded runs and cast metadata', async () => {
    const { app } = await setupRuns();

    const runs = await app.request('/runs');
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([{
      run_id: 'run-1',
      started_at: '2026-09-04T10:00:00.000Z',
      events: 3,
      panes: ['relay:7'],
    }]);

    const casts = await app.request('/runs/run-1/casts');
    expect(casts.status).toBe(200);
    expect(await casts.json()).toEqual([{
      pane_id: 'relay:7',
      header: { version: 2, width: 20, height: 5, timestamp: 1_788_458_400, title: 'backend' },
      duration: 2,
      events: 2,
    }]);
  });

  it('returns run events strictly after the since cursor', async () => {
    const { app } = await setupRuns();

    const response = await app.request('/runs/run-1/events?since=2');
    expect(response.status).toBe(200);
    expect(((await response.json()) as Event[]).map((event) => event.seq)).toEqual([3]);
    expect((await app.request('/runs/run-1/events?since=-1')).status).toBe(400);
  });

  it('seeks a pane screen and validates t', async () => {
    const { app } = await setupRuns();

    const response = await app.request('/runs/run-1/casts/relay:7/screen?t=1.5');
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as ScreenSnapshot;
    expect(snapshot).toMatchObject({ pane_id: 'relay:7', cols: 20, rows: 5, alternate: false });
    expect(snapshot.lines.some((line) => line.includes('hello'))).toBe(true);

    expect((await app.request('/runs/run-1/casts/relay:7/screen')).status).toBe(400);
    expect((await app.request('/runs/run-1/casts/relay:7/screen?t=-1')).status).toBe(400);
    expect((await app.request('/runs/run-1/casts/relay:7/screen?t=NaN')).status).toBe(400);
  });

  it('serves cast bytes and returns 404 for unknown runs or panes', async () => {
    const { app, castPath } = await setupRuns();

    const cast = await app.request('/runs/run-1/casts/relay:7');
    expect(cast.status).toBe(200);
    expect(await cast.text()).toBe(fs.readFileSync(castPath, 'utf8'));
    expect(cast.headers.get('content-type')).toMatch(/^text\/plain/);

    expect((await app.request('/runs/missing/casts')).status).toBe(404);
    expect((await app.request('/runs/run-1/casts/relay:99')).status).toBe(404);
    expect((await app.request('/runs/run-1/casts/relay:99/screen?t=1')).status).toBe(404);
  });
});
