import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CastRecorder } from './recorder.js';
import { castDuration, castInfo, screenAt } from './replay.js';

const directories: string[] = [];

function temporaryCast(name = 'relay:7.cast'): { castPath: string; setTime(seconds: number): void; recorder: CastRecorder } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  directories.push(dir);
  let now = 0;
  const recorder = new CastRecorder({
    path: path.join(dir, name),
    cols: 20,
    rows: 5,
    title: 'backend',
    timestamp: 1_788_454_800,
    now: () => now,
  });
  return { castPath: recorder.path, setTime: (seconds) => { now = seconds * 1_000; }, recorder };
}

async function knownCast(): Promise<string> {
  const { castPath, setTime, recorder } = temporaryCast();
  setTime(1);
  recorder.output('hello');
  setTime(2);
  recorder.output('\x1b[2J');
  setTime(3);
  recorder.output('world');
  setTime(4);
  recorder.resize(10, 3);
  await recorder.close();
  return castPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('screenAt', () => {
  it('rebuilds the visible screen at output, clear, and resize boundaries', async () => {
    const castPath = await knownCast();

    const hello = await screenAt(castPath, 1.5);
    expect(hello).toMatchObject({ pane_id: 'relay:7', cols: 20, rows: 5, alternate: false });
    expect(hello.lines).toHaveLength(5);
    expect(hello.lines.some((line) => line.includes('hello'))).toBe(true);

    const cleared = await screenAt(castPath, 2.5);
    expect(cleared.lines.every((line) => line === '')).toBe(true);

    const world = await screenAt(castPath, 3.5);
    expect(world.lines.some((line) => line.includes('world'))).toBe(true);

    const resized = await screenAt(castPath, 4.5);
    expect(resized).toMatchObject({ cols: 10, rows: 3 });
    expect(resized.lines).toHaveLength(3);
  });

  it('ignores a trailing partial JSON line while a cast is still being written', async () => {
    const castPath = await knownCast();
    fs.appendFileSync(castPath, '[5,"o","unfinished');

    await expect(screenAt(castPath, 10)).resolves.toMatchObject({ cols: 10, rows: 3 });
  });
});

describe('cast metadata', () => {
  it('reports the v2 header, duration, and event count', async () => {
    const castPath = await knownCast();

    expect(castDuration(castPath)).toBe(4);
    expect(castInfo(castPath)).toEqual({
      header: { version: 2, width: 20, height: 5, timestamp: 1_788_454_800, title: 'backend' },
      duration: 4,
      events: 4,
    });
  });
});

describe('replay cache', () => {
  it('reads an unchanged cast only once across repeated seeks', async () => {
    const castPath = await knownCast();
    const read = vi.spyOn(fs, 'readFileSync');

    await screenAt(castPath, 1.5);
    await screenAt(castPath, 3.5);

    expect(read.mock.calls.filter(([file]) => file === castPath)).toHaveLength(1);
  });
});

describe('replay performance', () => {
  it('seeks a 1 MB cast in under 500 ms', async () => {
    const { castPath, setTime, recorder } = temporaryCast();
    setTime(1);
    recorder.output('x'.repeat(1024 * 1024));
    await recorder.close();

    const started = performance.now();
    const snapshot = await screenAt(castPath, 1);
    const elapsed = performance.now() - started;

    expect(snapshot.lines.some((line) => line.length > 0)).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});
