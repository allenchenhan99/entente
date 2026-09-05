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
const until = async (pred: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> => {
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

  it('presses Enter once more while the composer still holds the paste (Codex shows "[Pasted Content …]")', async () => {
    const { host, dir } = makeHost();
    // Like Codex: the first Enter leaves the text in the composer and shows a paste placeholder above the
    // footer; only the second Enter submits, after which the agent is visibly working.
    const capture = path.join(dir, 'capture.json');
    const file = path.join(dir, 'agent.js');
    fs.writeFileSync(file, `
      const fs = require('fs'); let enters = 0; let after = '';
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { after += d; for (const ch of d) if (ch === '\\r') enters++; fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ after, enters }));
        if (enters === 1) process.stdout.write('\\r\\n› [Pasted Content 5 chars]\\r\\n  gpt-5.6-sol default · ~/x\\r\\n');
        if (enters >= 2) process.stdout.write('\\r\\n• Working (1s • esc to interrupt)\\r\\n'); });
      setTimeout(() => process.stdout.write('› Ask Codex to do anything\\r\\n  gpt-5.6-sol default · ~/x\\r\\n'), 100);
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

describe('relay host prompt timings', () => {
  it('records readiness, prompt write and accept timings with zero retries after a clean prompt delivery', async () => {
    const { host, dir } = makeHost();
    const agent = fakeAgent(dir, { prompt: 'booting...\r\n> ', delayMs: 200, reply: '\r\nworking\r\n' });
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: agent.argv, env: {}, prompt: 'do the thing' });
    const t = host.get(paneId)!.timings();
    expect(t.readiness_ms).toBeDefined();
    expect(t.prompt_write_ms).toBeDefined();
    expect(t.prompt_accept_ms).toBeDefined();
    expect(t.readiness_ms!).toBeGreaterThanOrEqual(0);
    expect(t.prompt_write_ms!).toBeGreaterThanOrEqual(0);
    expect(t.prompt_accept_ms!).toBeGreaterThanOrEqual(0);
    // Readiness waits for the quiet window after the prompt line, so it is at least quietMs after first output.
    expect(t.readiness_ms!).toBeGreaterThanOrEqual(fastTimings.quietMs - 20);
    expect(t.prompt_retries).toBe(0);
    expect(t.spawn_ms).toBeDefined();
    expect(t.first_output_ms).toBeDefined();
    expect(host.metrics().prompt_failures).toBe(0);
  });

  it('does not accept on a partial repaint: the footer moves first, the paste placeholder is painted later', async () => {
    const { host, dir } = makeHost();
    const capture = path.join(dir, 'capture.json');
    const file = path.join(dir, 'agent.js');
    fs.writeFileSync(file, `
      const fs = require('fs'); let enters = 0;
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { for (const ch of d) if (ch === '\\r') enters++; fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ enters }));
        if (enters === 1) { process.stdout.write('\\r\\n  gpt-5.6-sol default · ~/x · 5 chars\\r\\n');
          setTimeout(() => process.stdout.write('\\r\\n› [Pasted Content 5 chars]\\r\\n  gpt-5.6-sol default · ~/x · 5 chars\\r\\n'), 60); }
        if (enters >= 2) process.stdout.write('\\r\\n• Working (1s • esc to interrupt)\\r\\n'); });
      setTimeout(() => process.stdout.write('› Ask Codex to do anything\\r\\n  gpt-5.6-sol default · ~/x\\r\\n'), 100);
      setTimeout(() => process.exit(0), 20000);
    `);
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: [process.execPath, file], env: {}, prompt: 'hello' });
    const cap = JSON.parse(fs.readFileSync(capture, 'utf8'));
    expect(cap.enters).toBe(2);
    expect(host.get(paneId)!.timings().prompt_retries).toBe(1);
  });

  it('an echoing shell keeps the submitted line visible above its reply; that is not "still in the composer"', async () => {
    const { host, dir } = makeHost();
    const t0 = Date.now();
    const { paneId } = await host.spawn({ name: 'shell', cwd: dir, argv: ['sh', '-c', 'printf "> "; read x; echo "got:$x"; sleep 5'], env: {}, prompt: 'hello there' });
    expect(Date.now() - t0).toBeLessThan(fastTimings.timeoutMs);
    expect(host.get(paneId)!.timings().prompt_retries).toBe(0);
    expect(host.get(paneId)!.lastLine()).toBe('got:hello there');
  });

  it('counts the extra Enter presses as prompt_retries and includes them in prompt_accept_ms', async () => {
    const { host, dir } = makeHost();
    const file = path.join(dir, 'agent.js');
    fs.writeFileSync(file, `
      let enters = 0;
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { for (const ch of d) if (ch === '\\r') enters++;
        if (enters === 1) process.stdout.write('\\r\\n› [Pasted Content 5 chars]\\r\\n  gpt-5.6-sol default · ~/x\\r\\n');
        if (enters >= 2) process.stdout.write('\\r\\n• Working (1s • esc to interrupt)\\r\\n'); });
      setTimeout(() => process.stdout.write('› Ask Codex to do anything\\r\\n  gpt-5.6-sol default · ~/x\\r\\n'), 100);
      setTimeout(() => process.exit(0), 20000);
    `);
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: [process.execPath, file], env: {}, prompt: 'hello' });
    const t = host.get(paneId)!.timings();
    expect(t.prompt_retries).toBeGreaterThanOrEqual(1);
    expect(t.prompt_accept_ms!).toBeGreaterThanOrEqual(fastTimings.retryMs - 20);
    expect(t.readiness_ms).toBeDefined();
    expect(t.prompt_write_ms).toBeDefined();
  });

  it('a failed prompt delivery bumps prompt_failures and leaves the prompt marks undefined', async () => {
    const { host, dir } = makeHost();
    const agent = fakeAgent(dir, { prompt: 'still loading', delayMs: 100, reply: '' });
    await expect(host.spawn({ name: 'backend', cwd: dir, argv: agent.argv, env: {}, prompt: 'hello' })).rejects.toThrow(/agent prompt failed/);
    expect(host.metrics().prompt_failures).toBe(1);
    const t = host.get('relay:1')!.timings();
    expect(t.readiness_ms).toBeUndefined();
    expect(t.prompt_write_ms).toBeUndefined();
    expect(t.prompt_accept_ms).toBeUndefined();
  });
});

describe('relay host metrics', () => {
  it('counts every spawn (including exited panes), only live panes as alive, and lists each pane with timings', async () => {
    const { host, dir } = makeHost();
    const before = host.metrics();
    expect(before).toMatchObject({ host: 'relay', panes_spawned: 0, panes_alive: 0, prompt_failures: 0, panes: [] });
    expect(before.uptime_ms).toBeGreaterThanOrEqual(0);
    const gone = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'echo bye; exit 0'], env: {} });
    const live = await host.spawn({ name: 'planner', cwd: dir, argv: ['sh', '-c', 'read x'], env: {}, taskId: 't-plan' });
    await host.get(gone.paneId)!.exited;
    const m = host.metrics();
    expect(m).toMatchObject({ host: 'relay', panes_spawned: 2, panes_alive: 1, prompt_failures: 0 });
    expect(m.uptime_ms).toBeGreaterThanOrEqual(before.uptime_ms);
    expect(m.panes.map((p) => p.pane_id)).toEqual([gone.paneId, live.paneId]);
    expect(m.panes[0]).toMatchObject({ role: 'backend', timings: expect.objectContaining({ output_chunks: expect.any(Number) }) });
    expect(m.panes[0]!.task_id).toBeUndefined();
    expect(m.panes[1]).toMatchObject({ role: 'planner', task_id: 't-plan' });
    expect(host.get(live.paneId)!.info().task_id).toBe('t-plan');
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
