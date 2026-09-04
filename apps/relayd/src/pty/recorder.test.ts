import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CastRecorder } from './recorder.js';

describe('cast recorder', () => {
  it('writes an asciinema v2 header, o events and r events, flushed on every write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const file = path.join(dir, 'casts', 'relay:1.cast');
    let t = 0;
    const rec = new CastRecorder({ path: file, cols: 120, rows: 40, title: 'backend', now: () => t, timestamp: 1_700_000_000 });
    t = 250;
    rec.output('hello\r\n');
    t = 500;
    rec.resize(80, 24);
    t = 1000;
    rec.output('bye');
    await rec.flushed();
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(JSON.parse(lines[0]!)).toEqual({ version: 2, width: 120, height: 40, timestamp: 1_700_000_000, title: 'backend' });
    expect(JSON.parse(lines[1]!)).toEqual([0.25, 'o', 'hello\r\n']);
    expect(JSON.parse(lines[2]!)).toEqual([0.5, 'r', '80x24']);
    expect(JSON.parse(lines[3]!)).toEqual([1, 'o', 'bye']);
    await rec.close();
  });
});
