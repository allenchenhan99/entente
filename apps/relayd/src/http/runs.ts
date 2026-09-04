/** Read-only HTTP access to recorded run event logs and terminal casts. */
import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { Event } from '@relay/protocol';
import type { Event as EventType } from '@relay/protocol';
import type { EventStore } from '../ports.js';
import { loadConfig } from '../config.js';
import { castInfo, screenAt } from '../pty/replay.js';

export interface MountRunsOptions {
  relayDir?: string;
  /** A disk store exposes its events file, from which the config-derived relay directory is recovered. */
  store?: EventStore;
}

interface DiskStore extends EventStore {
  file: string;
}

const SAFE_COMPONENT = /^[0-9A-Za-z._:-]+$/;

function configuredRelayDir(options: MountRunsOptions): string {
  if (options.relayDir !== undefined) return path.resolve(options.relayDir);
  const file = (options.store as Partial<DiskStore> | undefined)?.file;
  if (typeof file === 'string') return path.dirname(path.dirname(path.dirname(path.resolve(file))));
  return loadConfig().relayDir;
}

function parseJsonLines(file: string): unknown[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const values: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      throw new Error(`${file}:${index + 1}: invalid JSON`);
    }
  }
  return values;
}

function readEvents(runDir: string): EventType[] {
  return parseJsonLines(path.join(runDir, 'events.jsonl')).map((value, index) => {
    const parsed = Event.safeParse(value);
    if (!parsed.success) throw new Error(`${path.join(runDir, 'events.jsonl')}:${index + 1}: invalid event`);
    return parsed.data;
  });
}

function castFiles(runDir: string): Array<{ paneId: string; file: string }> {
  const directory = path.join(runDir, 'casts');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cast'))
    .map((entry) => ({ paneId: entry.name.slice(0, -'.cast'.length), file: path.join(directory, entry.name) }))
    .sort((left, right) => left.paneId.localeCompare(right.paneId));
}

function existingDirectory(parent: string, component: string): string | undefined {
  if (!SAFE_COMPONENT.test(component) || component === '.' || component === '..') return undefined;
  const directory = path.join(parent, component);
  try {
    return fs.statSync(directory).isDirectory() ? directory : undefined;
  } catch {
    return undefined;
  }
}

function existingCast(runDir: string, paneId: string): string | undefined {
  if (!SAFE_COMPONENT.test(paneId) || paneId === '.' || paneId === '..') return undefined;
  const file = path.join(runDir, 'casts', `${paneId}.cast`);
  try {
    return fs.statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

function parseSince(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseTime(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const runNotFound = (c: Context, runId: string) => c.json({ error: `run ${runId} not found` }, 404);
const paneNotFound = (c: Context, paneId: string) => c.json({ error: `cast for ${paneId} not found` }, 404);

export function mountRuns(app: Hono, options: MountRunsOptions = {}): void {
  const relayDir = configuredRelayDir(options);
  const runsDir = path.join(relayDir, 'runs');
  const withRun = async (c: Context, handler: (runDir: string) => Response | Promise<Response>): Promise<Response> => {
    const runId = c.req.param('run') ?? '';
    const runDir = existingDirectory(runsDir, runId);
    if (!runDir) return runNotFound(c, runId);
    return handler(runDir);
  };

  app.get('/runs', (c) => {
    if (!fs.existsSync(runsDir)) return c.json([]);
    const runs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const runDir = path.join(runsDir, entry.name);
        const events = readEvents(runDir);
        const casts = castFiles(runDir);
        const firstCastTimestamp = casts.length === 0 ? undefined : castInfo(casts[0]!.file).header.timestamp;
        const startedAt = events[0]?.ts
          ?? (typeof firstCastTimestamp === 'number' ? new Date(firstCastTimestamp * 1_000).toISOString() : fs.statSync(runDir).birthtime.toISOString());
        return { run_id: entry.name, started_at: startedAt, events: events.length, panes: casts.map((cast) => cast.paneId) };
      });
    return c.json(runs);
  });

  app.get('/runs/:run/events', (c) => withRun(c, (runDir) => {
    const since = parseSince(c.req.query('since'));
    if (since === undefined) return c.json({ errors: ['since: must be a non-negative integer'] }, 400);
    return c.json(readEvents(runDir).filter((event) => event.seq > since));
  }));

  app.get('/runs/:run/casts', (c) => withRun(c, (runDir) => c.json(castFiles(runDir).map(({ paneId, file }) => ({
    pane_id: paneId,
    ...castInfo(file),
  })))));

  app.get('/runs/:run/casts/:pane/screen', (c) => withRun(c, async (runDir) => {
    const paneId = c.req.param('pane') ?? '';
    const file = existingCast(runDir, paneId);
    if (!file) return paneNotFound(c, paneId);
    const time = parseTime(c.req.query('t'));
    if (time === undefined) return c.json({ errors: ['t: must be a non-negative number'] }, 400);
    return c.json(await screenAt(file, time, { paneId }));
  }));

  app.get('/runs/:run/casts/:pane', (c) => withRun(c, (runDir) => {
    const paneId = c.req.param('pane') ?? '';
    const file = existingCast(runDir, paneId);
    if (!file) return paneNotFound(c, paneId);
    return c.body(fs.readFileSync(file, 'utf8'), 200, { 'content-type': 'text/plain; charset=utf-8' });
  }));
}
