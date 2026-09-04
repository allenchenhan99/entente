import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pane } from './pane.js';
import { RING_CAPACITY } from './pane.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
const panes: Pane[] = [];
const open = (argv: string[], over: Partial<ConstructorParameters<typeof Pane>[0]> = {}) => {
  const dir = tmp();
  const pane = new Pane({ paneId: `relay:${panes.length + 1}`, role: 'backend', argv, cwd: dir, env: {}, castPath: path.join(dir, 'casts', 'p.cast'), ...over });
  panes.push(pane);
  return pane;
};
const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};

afterEach(async () => {
  for (const p of panes.splice(0)) await p.kill(50);
});

describe('pane screen model', () => {
  it('snapshot shows printed lines, cursor and no alternate screen', async () => {
    const pane = open(['sh', '-c', "printf 'a\\nb\\nc\\n'; read x"]);
    await until(() => pane.snapshot({ source: 'visible', lines: 200 }).lines[2] === 'c');
    const snap = pane.snapshot({ source: 'visible', lines: 200 });
    expect(snap.pane_id).toBe(pane.id);
    expect(snap.lines.slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(snap.lines).toHaveLength(40);
    expect(snap.cols).toBe(120);
    expect(snap.rows).toBe(40);
    expect(snap.cursor).toEqual({ x: 0, y: 3 });
    expect(snap.alternate).toBe(false);
    expect(snap.scrollback_lines).toBe(0);
  });

  it('flips alternate:true when the program enters the alternate screen', async () => {
    const pane = open(['sh', '-c', "printf 'main\\n'; printf '\\033[?1049h'; printf 'alt'; read x"]);
    await until(() => pane.snapshot({ source: 'visible', lines: 200 }).lines.includes('alt'));
    const snap = pane.snapshot({ source: 'visible', lines: 200 });
    expect(snap.alternate).toBe(true);
    // The alternate buffer keeps the cursor row, so `alt` sits on the row after `main`'s newline.
    expect(snap.lines).not.toContain('main');
    expect(snap.lines[1]).toBe('alt');
  });

  it('recent prepends scrollback rows once more lines than rows were printed', async () => {
    const pane = open(['sh', '-c', "i=1; while [ $i -le 50 ]; do echo line$i; i=$((i+1)); done; read x"], { rows: 10 });
    await until(() => pane.snapshot({ source: 'visible', lines: 200 }).scrollback_lines >= 41);
    const visible = pane.snapshot({ source: 'visible', lines: 200 });
    expect(visible.lines).toHaveLength(10);
    expect(visible.lines[0]).toBe('line42');
    const recent = pane.snapshot({ source: 'recent', lines: 5 });
    expect(recent.lines).toHaveLength(15);
    expect(recent.lines[0]).toBe('line37');
    const all = pane.snapshot({ source: 'recent', lines: 200 });
    expect(all.lines[0]).toBe('line1');
    expect(all.lines).toHaveLength(51);
  });
});

describe('pane process', () => {
  it('reports pid, alive, exit code, and keeps the raw ring and cast', async () => {
    const pane = open(['sh', '-c', "printf 'hi\\n'; exit 3"]);
    expect(pane.info().pid).toBeGreaterThan(0);
    expect(pane.info().alive).toBe(true);
    const code = await pane.exited;
    expect(code).toBe(3);
    const info = pane.info();
    expect(info).toMatchObject({ alive: false, exit_code: 3, role: 'backend', cols: 120, rows: 40, cast_path: pane.castPath });
    expect(info.exited_at).toBeTruthy();
    expect(pane.scrollback().toString()).toContain('hi');
    await pane.recorder.flushed();
    const cast = fs.readFileSync(pane.castPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(cast[0]).toMatchObject({ version: 2, width: 120, height: 40, title: 'backend' });
    expect(cast.slice(1).filter((e) => e[1] === 'o').map((e) => e[2]).join('')).toContain('hi');
  });

  it('resize changes pty, screen and writes an r event; the ring keeps only the last 256 KiB', async () => {
    const pane = open(['sh', '-c', "head -c 300000 /dev/zero | tr '\\0' 'x'; echo; echo done; read x"]);
    await until(() => pane.snapshot({ source: 'visible', lines: 1 }).lines.some((l) => l === 'done'), 10_000);
    expect(pane.scrollback().length).toBeLessThanOrEqual(RING_CAPACITY);
    expect(pane.scrollback().toString()).toContain('done');
    pane.resize(80, 24);
    expect(pane.snapshot({ source: 'visible', lines: 1 }).cols).toBe(80);
    expect(pane.info()).toMatchObject({ cols: 80, rows: 24 });
    await pane.recorder.flushed();
    const cast = fs.readFileSync(pane.castPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(cast.some((e) => e[1] === 'r' && e[2] === '80x24')).toBe(true);
  });

  it('write delivers bytes; onOutput subscribers see every chunk; kill escalates to SIGKILL', async () => {
    const pane = open(['sh', '-c', "trap '' TERM; read x; echo got:$x; sleep 30"]);
    const seen: string[] = [];
    const off = pane.onOutput((chunk) => seen.push(chunk.toString()));
    pane.write('hello\r');
    await until(() => seen.join('').includes('got:hello'));
    off();
    const t0 = Date.now();
    await pane.kill(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(pane.info().alive).toBe(false);
    expect(pane.readiness(Date.now())).toMatchObject({ ready: false, source: 'unknown' });
  });
});

describe('pane timings', () => {
  it('reports spawn, first output, render p50/p95 and throughput for a bursty printer', async () => {
    const pane = open(['sh', '-c', 'printf "x%.0s" $(seq 1 2000); sleep 0.2; echo done']);
    await pane.exited;
    const t = pane.timings();
    expect(t.output_bytes).toBeGreaterThanOrEqual(2000);
    expect(t.output_chunks).toBeGreaterThanOrEqual(1);
    expect(t.render_p50_ms).toBeDefined();
    expect(t.render_p95_ms).toBeDefined();
    expect(t.render_p50_ms!).toBeLessThan(100);
    expect(t.render_p95_ms!).toBeLessThan(100);
    expect(t.render_p50_ms!).toBeLessThanOrEqual(t.render_p95_ms!);
    expect(t.spawn_ms).toBeDefined();
    expect(t.first_output_ms).toBeDefined();
    expect(t.spawn_ms!).toBeGreaterThanOrEqual(0);
    expect(t.first_output_ms!).toBeGreaterThanOrEqual(0);
    // A pane spawned without a prompt never reaches the readiness / prompt marks.
    expect(t.readiness_ms).toBeUndefined();
    expect(t.prompt_write_ms).toBeUndefined();
    expect(t.prompt_accept_ms).toBeUndefined();
    expect(t.prompt_retries).toBeUndefined();
    expect(pane.info().timings).toEqual(t);
  });

  it('timings before any output carry spawn_ms only and no render samples', () => {
    const pane = open(['sh', '-c', 'read x']);
    const t = pane.timings();
    expect(t.spawn_ms).toBeGreaterThanOrEqual(0);
    expect(t.first_output_ms).toBeUndefined();
    expect(t.render_p50_ms).toBeUndefined();
    expect(t.render_p95_ms).toBeUndefined();
    expect(t).toMatchObject({ output_bytes: 0, output_chunks: 0 });
  });
});
