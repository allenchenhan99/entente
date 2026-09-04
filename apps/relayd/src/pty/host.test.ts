import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayHost, type RelayHost } from './host.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
const hosts: RelayHost[] = [];
const fastTimings = { quietMs: 100, retryMs: 300, timeoutMs: 3000 };
const makeHost = (dir = tmp()) => {
  const host = createRelayHost({ relayDir: path.join(dir, '.relay'), runId: 'run-1', timings: fastTimings });
  hosts.push(host);
  return { host, dir };
};
const until = async (pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake interactive agent: raw-mode stdin, prints `prompt` after `delayMs`, records every input byte with the
 * phase it arrived in (`before`/`after` the prompt) to `capture`, and on each `\r` after the prompt prints `reply`.
 */
function fakeAgent(dir: string, o: { prompt: string; delayMs: number; reply: string; exitOnEnter?: number }): { argv: string[]; capture: string } {
  const capture = path.join(dir, 'capture.json');
  const script = `
    const fs = require('fs');
    const got = { before: '', after: '' }; let phase = 'before'; let enters = 0;
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const save = () => fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ ...got, enters }));
    process.stdin.on('data', (d) => {
      got[phase] += d; save();
      if (phase === 'after') for (const ch of d) if (ch === '\\r') { enters++; save(); process.stdout.write(${JSON.stringify(o.reply)}); if (${o.exitOnEnter ?? 0} && enters >= ${o.exitOnEnter ?? 0}) process.exit(0); }
    });
    setTimeout(() => { process.stdout.write(${JSON.stringify(o.prompt)}); phase = 'after'; }, ${o.delayMs});
    setTimeout(() => process.exit(0), 20000);
  `;
  const file = path.join(dir, 'agent.js');
  fs.writeFileSync(file, script);
  return { argv: [process.execPath, file], capture };
}
const readCapture = (file: string): { before: string; after: string; enters: number } => JSON.parse(fs.readFileSync(file, 'utf8'));

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.killAll(50);
});

describe('relay host spawn', () => {
  it('numbers panes relay:1, relay:2 and passes cwd, env, TERM and RELAY_PANE_ID', async () => {
    const { host, dir } = makeHost();
    const out = path.join(dir, 'env.txt');
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', `printf '%s|%s|%s|%s|%s' "$PWD" "$TERM" "$COLORTERM" "$RELAY_PANE_ID" "$EXTRA" > ${out}`], env: { EXTRA: 'yes' } });
    expect(paneId).toBe('relay:1');
    expect(host.kind).toBe('relay');
    const second = await host.spawn({ name: 'planner', cwd: dir, argv: ['sh', '-c', 'read x'], env: {} });
    expect(second.paneId).toBe('relay:2');
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('|'));
    await host.get('relay:1')!.exited;
    expect(fs.readFileSync(out, 'utf8')).toBe(`${dir}|xterm-256color|truecolor|relay:1|yes`);
    const list = host.list();
    expect(list.map((p) => p.pane_id)).toEqual(['relay:1', 'relay:2']);
    expect(list[1]).toMatchObject({ role: 'planner', alive: true, cols: 120, rows: 40, cast_path: path.join(dir, '.relay', 'runs', 'run-1', 'casts', 'relay:2.cast') });
    expect(fs.existsSync(list[1]!.cast_path!)).toBe(true);
    expect(await host.isAlive('relay:2')).toBe(true);
    expect(await host.isAlive('relay:1')).toBe(false);
    expect(await host.isAlive('relay:99')).toBe(false);
  });

  it('focus records the focused pane; kill terminates and unknown panes throw', async () => {
    const { host, dir } = makeHost();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'read x'], env: {} });
    await host.focus(paneId);
    expect(host.focusedPane).toBe(paneId);
    await expect(host.focus('relay:9')).rejects.toThrow(/not found/);
    await expect(host.kill('relay:9')).rejects.toThrow(/not found/);
    await host.kill(paneId);
    expect(await host.isAlive(paneId)).toBe(false);
    await host.kill(paneId); // idempotent once exited
  });

  it('rejects an empty argv without creating a pane', async () => {
    const { host, dir } = makeHost();
    await expect(host.spawn({ name: 'x', cwd: dir, argv: [], env: {} })).rejects.toThrow(/argv/);
    expect(host.list()).toEqual([]);
  });
});

describe('relay host prompt delivery', () => {
  it('writes the prompt only after the prompt line appears and the screen is quiet, then Enter', async () => {
    const { host, dir } = makeHost();
    const agent = fakeAgent(dir, { prompt: 'booting...\r\n> ', delayMs: 300, reply: '\r\nworking\r\n' });
    const t0 = Date.now();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: agent.argv, env: {}, prompt: 'do the thing' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300 + fastTimings.quietMs);
    await until(() => fs.existsSync(agent.capture) && readCapture(agent.capture).enters >= 1);
    const cap = readCapture(agent.capture);
    expect(cap.before).toBe('');
    expect(cap.after).toBe('do the thing\r');
    expect(cap.enters).toBe(1);
    expect(host.get(paneId)!.lastLine()).toBe('working');
  });

  it('wraps the prompt in bracketed-paste markers when the pane enabled them', async () => {
    const { host, dir } = makeHost();
    const agent = fakeAgent(dir, { prompt: '\x1b[?2004h> ', delayMs: 100, reply: '\r\nok\r\n' });
    await host.spawn({ name: 'backend', cwd: dir, argv: agent.argv, env: {}, prompt: 'multi\nline' });
    await until(() => fs.existsSync(agent.capture) && readCapture(agent.capture).enters >= 1);
    expect(readCapture(agent.capture).after).toBe('\x1b[200~multi\nline\x1b[201~\r');
  });

  it('presses Enter once more when the last line has not changed after the retry delay', async () => {
    const { host, dir } = makeHost();
    // Reply only on the second Enter: the first one is "swallowed" like a composer keeping the paste.
    const capture = path.join(dir, 'capture.json');
    const file = path.join(dir, 'agent.js');
    fs.writeFileSync(file, `
      const fs = require('fs'); let enters = 0; let after = '';
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { after += d; for (const ch of d) if (ch === '\\r') enters++; fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ after, enters }));
        if (enters >= 2) process.stdout.write('\\r\\nworking\\r\\n'); });
      setTimeout(() => process.stdout.write('> '), 100);
      setTimeout(() => process.exit(0), 20000);
    `);
    const t0 = Date.now();
    await host.spawn({ name: 'backend', cwd: dir, argv: [process.execPath, file], env: {}, prompt: 'hello' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(fastTimings.retryMs);
    const cap = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(cap.enters).toBe(2);
    expect(cap.after).toBe('hello\r\r');
  });

  it('gives up after the timeout with "agent prompt failed" and leaves the pane open', async () => {
    const { host, dir } = makeHost();
    const agent = fakeAgent(dir, { prompt: 'still loading', delayMs: 100, reply: '' });
    await expect(host.spawn({ name: 'backend', cwd: dir, argv: agent.argv, env: {}, prompt: 'hello' })).rejects.toThrow(/agent prompt failed/);
    expect(host.list()).toHaveLength(1);
    expect(await host.isAlive('relay:1')).toBe(true);
    // The agent writes its capture file on the first input byte: no file = nothing was ever typed.
    expect(fs.existsSync(agent.capture)).toBe(false);
  });

  it('fails fast when the process exits before it could take the prompt', async () => {
    const { host, dir } = makeHost();
    await expect(host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'echo bye; exit 2'], env: {}, prompt: 'hello' })).rejects.toThrow(/agent prompt failed.*exited/);
  });
});

describe('relay host readiness and wait-output', () => {
  it('readiness is false while output streams and true once a $ prompt line is idle', async () => {
    const { host, dir } = makeHost();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'yes | head -c 100000; sleep 0.05; printf "$ "; read x'], env: {} });
    const pane = host.get(paneId)!;
    await pane.firstOutput;
    const streaming = host.readiness(paneId);
    expect(streaming).toMatchObject({ pane_id: paneId, ready: false, source: 'screen' });
    await until(() => host.readiness(paneId).ready, 5000);
    expect(host.readiness(paneId)).toMatchObject({ ready: true, source: 'screen', detail: expect.stringContaining('$') });
    expect(host.readiness('relay:77')).toBeUndefined();
    await host.kill(paneId);
    expect(host.readiness(paneId)).toMatchObject({ ready: false, source: 'unknown' });
  });

  it('wait-output resolves on a later echo, times out when nothing matches, and reports exit', async () => {
    const { host, dir } = makeHost();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'echo first; read x; echo "got $x"; read y; exit 0'], env: {} });
    expect(await host.waitOutput(paneId, { match: 'first', timeout_ms: 2000, source: 'recent' })).toMatchObject({ status: 'matched', line: 'first' });
    const later = host.waitOutput(paneId, { regex: '^got (\\w+)$', timeout_ms: 5000, source: 'recent' });
    await sleep(100);
    host.get(paneId)!.write('tada\r');
    expect(await later).toMatchObject({ status: 'matched', line: 'got tada', at: expect.any(String) });
    expect(await host.waitOutput(paneId, { match: 'never', timeout_ms: 150, source: 'recent' })).toEqual({ status: 'timeout' });
    const exiting = host.waitOutput(paneId, { match: 'never', timeout_ms: 5000, source: 'recent' });
    host.get(paneId)!.write('\r');
    expect(await exiting).toEqual({ status: 'exited', code: 0 });
    expect(await host.waitOutput(paneId, { match: 'never', timeout_ms: 100, source: 'recent' })).toEqual({ status: 'exited', code: 0 });
    expect(await host.waitOutput(paneId, { match: 'first', timeout_ms: 100, source: 'visible' })).toMatchObject({ status: 'matched' });
  });
});
