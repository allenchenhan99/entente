import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { PaneInfo, ScreenSnapshot, PaneReadiness, WaitOutputResult } from '@relay/protocol';
import { createRelayHost, type RelayHost } from './host.js';
import { startTestServer, type TestServer } from './test-server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
const cleanups: (() => Promise<void>)[] = [];
async function setup(): Promise<{ host: RelayHost; dir: string; srv: TestServer }> {
  const dir = tmp();
  const host = createRelayHost({ relayDir: path.join(dir, '.relay'), runId: 'run-1', timings: { quietMs: 100, retryMs: 300, timeoutMs: 3000 } });
  const srv = await startTestServer(host);
  cleanups.push(async () => { await srv.close(); await host.killAll(50); });
  return { host, dir, srv };
}
const until = async (pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const b64 = (s: string) => Buffer.from(s).toString('base64');

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('pty roundtrip', () => {
  it('WS client gets hello, scrollback, output containing hi; input ends the process; exit frame and pane info follow', async () => {
    const { host, dir, srv } = await setup();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'echo hi; read line; printf "bye %s\\n" "$line"; exit 0'], env: {} });
    const client = await srv.client(paneId);
    const [hello] = await client.frames_of('hello');
    expect(hello.pane).toMatchObject({ pane_id: paneId, role: 'backend', alive: true, cols: 120, rows: 40 });
    expect(client.frames[0]!.t).toBe('hello');
    expect(client.frames[1]!.t).toBe('scrollback');
    await until(() => client.output().includes('hi'));
    expect(client.frames.slice(2).every((f) => f.t === 'output')).toBe(true);
    client.send({ t: 'input', data: b64('exit\r') });
    const [exit] = await client.frames_of('exit');
    expect(exit.code).toBe(0);
    expect(client.output()).toContain('bye exit');
    const info = await srv.json<PaneInfo>('GET', `/panes/${paneId}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ pane_id: paneId, alive: false, exit_code: 0, exited_at: expect.any(String) });
    // ping/pong still works on an exited pane's socket.
    client.send({ t: 'ping' });
    await client.frames_of('pong');
  });

  it('rejects an unknown pane with 404 before upgrade and ignores malformed client frames', async () => {
    const { host, dir, srv } = await setup();
    await expect(srv.client('relay:404')).rejects.toThrow(/404/);
    const bogus = new WebSocket(`${srv.wsUrl}/nope`);
    await expect(new Promise((_, reject) => bogus.once('unexpected-response', (_r, res) => reject(new Error(String(res.statusCode)))))).rejects.toThrow(/404/);
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'read x; echo "ok:$x"'], env: {} });
    const client = await srv.client(paneId);
    client.ws.send('not json');
    client.send({ t: 'teleport' });
    client.send({ t: 'resize', cols: 80, rows: 24 });
    client.send({ t: 'input', data: b64('go\r') });
    await until(() => client.output().includes('ok:go'));
    expect((await srv.json<PaneInfo>('GET', `/panes/${paneId}`)).body).toMatchObject({ cols: 80, rows: 24 });
  });
});

describe('pty screen endpoint', () => {
  it('GET /panes/:id/screen returns the visible lines, alternate flag, and recent scrollback', async () => {
    const { host, dir, srv } = await setup();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', "printf 'a\\nb\\nc\\n'; read x; i=1; while [ $i -le 12 ]; do echo L$i; i=$((i+1)); done; read y; printf '\\033[?1049h'; read z"], env: {}, rows: 6 });
    await until(async () => (await srv.json<ScreenSnapshot>('GET', `/panes/${paneId}/screen`)).body.lines[2] === 'c');
    let snap = (await srv.json<ScreenSnapshot>('GET', `/panes/${paneId}/screen`)).body;
    expect(snap.lines.slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(snap.alternate).toBe(false);
    expect(snap.rows).toBe(6);
    host.get(paneId)!.write('\r');
    await until(async () => (await srv.json<ScreenSnapshot>('GET', `/panes/${paneId}/screen`)).body.scrollback_lines >= 10);
    snap = (await srv.json<ScreenSnapshot>('GET', `/panes/${paneId}/screen?source=recent&lines=4`)).body;
    // 6 visible rows (L8..L12 + the cursor line) preceded by the 4 requested scrollback rows.
    expect(snap.lines).toHaveLength(10);
    expect(snap.lines[0]).toBe('L4');
    expect(snap.lines.at(-2)).toBe('L12');
    expect(snap.scrollback_lines).toBe(11);
    host.get(paneId)!.write('\r');
    await until(async () => (await srv.json<ScreenSnapshot>('GET', `/panes/${paneId}/screen`)).body.alternate);
    expect((await srv.json('GET', `/panes/${paneId}/screen?source=sideways`)).status).toBe(400);
    expect((await srv.json('GET', `/panes/${paneId}/screen?lines=0`)).status).toBe(400);
    expect((await srv.json('GET', `/panes/relay:9/screen`)).status).toBe(404);
  });
});

describe('pty clients and cast', () => {
  it('two clients receive the same output, a late client gets the scrollback first, and the cast matches', async () => {
    const { host, dir, srv } = await setup();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'echo one; read x; echo "two $x"; read y; echo three; exit 0'], env: {} });
    const pane = host.get(paneId)!;
    await until(() => pane.scrollback().toString().includes('one'));
    const a = await srv.client(paneId);
    const b = await srv.client(paneId);
    const [sa] = await a.frames_of('scrollback');
    const [sb] = await b.frames_of('scrollback');
    expect(Buffer.from(sa.data, 'base64').toString()).toContain('one');
    expect(sb.data).toBe(sa.data);
    a.send({ t: 'input', data: b64('x\r') });
    await until(() => a.output().includes('two x') && b.output().includes('two x'));
    expect(a.output()).toBe(b.output());
    // A late client receives the retained bytes first, then only what comes after.
    const late = await srv.client(paneId);
    const [sl] = await late.frames_of('scrollback');
    expect(sl.data).toBe(pane.scrollback().toString('base64'));
    expect(Buffer.from(sl.data, 'base64').toString()).toContain('two x');
    expect(late.output()).toBe('');
    late.send({ t: 'resize', cols: 100, rows: 30 });
    await until(() => pane.info().cols === 100);
    b.send({ t: 'input', data: b64('\r') });
    await Promise.all([a.frames_of('exit'), b.frames_of('exit'), late.frames_of('exit')]);
    expect(late.output()).toContain('three');
    expect(a.output()).toBe(b.output());

    await pane.recorder.flushed();
    const castRes = await srv.json<string>('GET', `/panes/${paneId}/cast`);
    expect(castRes.status).toBe(200);
    const events = castRes.text.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(events[0]).toEqual({ version: 2, width: 120, height: 40, timestamp: expect.any(Number), title: 'backend' });
    const recorded = events.slice(1).filter((e) => e[1] === 'o').map((e) => e[2]).join('');
    expect(recorded).toBe(Buffer.from(sa.data, 'base64').toString() + a.output());
    expect(events.some((e) => e[1] === 'r' && e[2] === '100x30')).toBe(true);
    expect(events.slice(1).every((e) => typeof e[0] === 'number' && e[0] >= 0)).toBe(true);
    expect((await srv.json('GET', '/panes/relay:9/cast')).status).toBe(404);
  });
});

describe('pty pane listing, focus and kill', () => {
  it('GET /panes lists panes with focused_pane; focus and kill act on known panes only', async () => {
    const { host, dir, srv } = await setup();
    expect((await srv.json('GET', '/panes')).body).toEqual({ panes: [] });
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'read x'], env: {} });
    expect((await srv.json('POST', `/panes/${paneId}/focus`)).body).toEqual({ ok: true });
    const list = await srv.json<{ panes: PaneInfo[]; focused_pane?: string }>('GET', '/panes');
    expect(list.body.focused_pane).toBe(paneId);
    expect(list.body.panes.map((p) => p.pane_id)).toEqual([paneId]);
    expect((await srv.json('POST', '/panes/relay:9/focus')).status).toBe(404);
    expect((await srv.json('POST', '/panes/relay:9/kill')).status).toBe(404);
    expect((await srv.json('GET', '/panes/relay:9')).status).toBe(404);
    expect((await srv.json('POST', `/panes/${paneId}/kill`)).body).toEqual({ ok: true });
    expect((await srv.json<PaneInfo>('GET', `/panes/${paneId}`)).body.alive).toBe(false);
  });
});

describe('pty readiness and wait-output endpoints', () => {
  it('readiness reports the screen tier and wait-output long-polls', async () => {
    const { host, dir, srv } = await setup();
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: ['sh', '-c', 'printf "$ "; read x; echo "echo:$x"; read y; exit 4'], env: {} });
    await until(async () => (await srv.json<PaneReadiness>('GET', `/panes/${paneId}/readiness`)).body.ready);
    expect((await srv.json<PaneReadiness>('GET', `/panes/${paneId}/readiness`)).body).toMatchObject({ pane_id: paneId, ready: true, source: 'screen', observed_at: expect.any(String) });
    expect((await srv.json('GET', '/panes/relay:9/readiness')).status).toBe(404);

    const pending = srv.json<WaitOutputResult>('POST', `/panes/${paneId}/wait-output`, { match: 'echo:hey' });
    await new Promise((r) => setTimeout(r, 100));
    expect((await srv.json('POST', `/panes/${paneId}/input`, { text: 'hey', keys: ['enter'] })).body).toEqual({ ok: true });
    expect((await pending).body).toMatchObject({ status: 'matched', line: 'echo:hey' });
    expect((await srv.json<WaitOutputResult>('POST', `/panes/${paneId}/wait-output`, { regex: 'nope', timeout_ms: 100 })).body).toEqual({ status: 'timeout' });
    expect((await srv.json('POST', `/panes/${paneId}/wait-output`, { timeout_ms: 100 })).status).toBe(400);
    expect((await srv.json('POST', `/panes/${paneId}/wait-output`, { regex: '(', timeout_ms: 100 })).status).toBe(400);
    expect((await srv.json('POST', `/panes/${paneId}/wait-output`, { match: 'x', timeout_ms: -1 })).status).toBe(400);
    const exiting = srv.json<WaitOutputResult>('POST', `/panes/${paneId}/wait-output`, { match: 'never' });
    await new Promise((r) => setTimeout(r, 50));
    await srv.json('POST', `/panes/${paneId}/input`, { keys: ['enter'] });
    expect((await exiting).body).toEqual({ status: 'exited', code: 4 });
    expect((await srv.json('POST', '/panes/relay:9/wait-output', { match: 'x' })).status).toBe(404);
  });
});

describe('pty input keys', () => {
  it('maps enter, esc, ctrl+c, arrows and backspace to the documented bytes; unknown key is a 400 that writes nothing', async () => {
    const { host, dir, srv } = await setup();
    const capture = path.join(dir, 'capture.txt');
    const script = path.join(dir, 'cap.js');
    fs.writeFileSync(script, `
      const fs = require('fs'); let got = '';
      process.stdin.setRawMode(true); process.stdin.resume();
      process.stdin.on('data', (d) => { got += d.toString('latin1'); fs.writeFileSync(${JSON.stringify(capture)}, got); if (got.includes('\\x04')) process.exit(0); });
      process.stdout.write('ready\\r\\n');
      setTimeout(() => process.exit(0), 20000);
    `);
    const { paneId } = await host.spawn({ name: 'backend', cwd: dir, argv: [process.execPath, script], env: {} });
    // Bytes typed before the agent enters raw mode would be cooked by the tty (ctrl+c → SIGINT): wait for it.
    expect((await srv.json('POST', `/panes/${paneId}/wait-output`, { match: 'ready' })).body).toMatchObject({ status: 'matched' });
    const bad = await srv.json<{ errors: string[] }>('POST', `/panes/${paneId}/input`, { text: 'nope', keys: ['enter', 'hyper+x'] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.join()).toMatch(/hyper\+x/);
    expect((await srv.json('POST', `/panes/${paneId}/input`, { keys: 'enter' })).status).toBe(400);
    expect((await srv.json('POST', '/panes/relay:9/input', { keys: ['enter'] })).status).toBe(404);
    expect((await srv.json('POST', `/panes/${paneId}/input`, { text: 'ab', keys: ['enter', 'esc', 'ctrl+c', 'up', 'down', 'left', 'right', 'tab', 'backspace', 'ctrl+d'] })).body).toEqual({ ok: true });
    await host.get(paneId)!.exited;
    expect(fs.readFileSync(capture, 'latin1')).toBe('ab\r\x1b\x03\x1b[A\x1b[B\x1b[D\x1b[C\t\x7f\x04');
  });
});
