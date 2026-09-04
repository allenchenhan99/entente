import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { createTerminalHost } from '../index.js';
import { loadConfig } from '../../config.js';
import { RelaytermHost, findTermdBinary } from './relayterm.js';

const ROOT = path.resolve(__dirname, '../../../../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));

/**
 * Fake termd: a plain `node:http` server implementing the routes the host uses (`POST /panes`, `GET /panes`,
 * `GET /panes/:id`, `POST /panes/:id/kill|focus`, `GET /metrics`) with canned data, recording every request at
 * `GET /__requests`. It parses the real CLI flags, prints the documented listening line to stdout and logs to
 * stderr, so the host's stdout parsing and stderr ring are exercised for real.
 * Knobs (env): FAKE_TERMD_EXIT_CODE=n → print "boom" to stderr and exit n before listening;
 * FAKE_TERMD_SILENT=1 → never print the listening line; FAKE_TERMD_IGNORE_SIGTERM=1 → survive SIGTERM;
 * FAKE_TERMD_ARGV_FILE=<file> → write argv (JSON) there once listening.
 */
const FAKE_TERMD_JS = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const token = flag('--token');
const firstPane = Number(flag('--first-pane') ?? '1');
if (process.env.FAKE_TERMD_EXIT_CODE) { process.stderr.write('boom: cannot start\n'); process.exit(Number(process.env.FAKE_TERMD_EXIT_CODE)); }
if (process.env.FAKE_TERMD_IGNORE_SIGTERM) process.on('SIGTERM', () => process.stderr.write('ignoring SIGTERM\n'));
let next = firstPane;
const panes = new Map();
const requests = [];
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const auth = req.headers.authorization;
    requests.push({ method: req.method, url: req.url, auth, body });
    process.stderr.write('fake termd: ' + req.method + ' ' + req.url + '\n');
    if (req.url === '/__requests') return json(res, 200, requests);
    if (auth !== 'Bearer ' + token) return json(res, 401, { error: 'invalid session token' });
    if (req.method === 'POST' && req.url === '/panes') {
      if (body.name === 'crash') { process.stderr.write('fatal: simulated crash\n'); process.exit(3); }
      const pane_id = 'relay:' + next++;
      const info = { pane_id, role: body.name, task_id: body.task_id, cwd: body.cwd, alive: true, cols: body.cols ?? 120, rows: body.rows ?? 40, started_at: new Date().toISOString(), pid: 4242, timings: {} };
      panes.set(pane_id, info);
      if (body.prompt && body.prompt.includes('FAIL')) return json(res, 502, { pane_id, error: 'agent prompt failed: no prompt on screen within 30000 ms (last line: ""); pane ' + pane_id + ' left open for diagnosis' });
      return json(res, 201, { pane_id });
    }
    if (req.method === 'GET' && req.url === '/panes') return json(res, 200, { panes: [...panes.values()] });
    if (req.method === 'GET' && req.url === '/metrics') return json(res, 200, { host: 'relayterm', uptime_ms: 1, panes_spawned: panes.size, panes_alive: [...panes.values()].filter((p) => p.alive).length, prompt_failures: 0, panes: [], argv });
    const m = /^\/panes\/([^/]+)(?:\/(kill|focus))?$/.exec(req.url);
    if (!m) return json(res, 404, { error: 'no route' });
    const pane = panes.get(m[1]);
    if (!pane) return json(res, 404, { error: 'pane not found' });
    if (m[2] === 'kill') { pane.alive = false; pane.exit_code = 1; return json(res, 200, { ok: true }); }
    if (m[2] === 'focus') return json(res, 200, { ok: true });
    return json(res, 200, pane);
  });
});
server.listen(0, '127.0.0.1', () => {
  if (process.env.FAKE_TERMD_ARGV_FILE) fs.writeFileSync(process.env.FAKE_TERMD_ARGV_FILE, JSON.stringify(argv));
  process.stderr.write('fake termd: starting\n');
  if (!process.env.FAKE_TERMD_SILENT) process.stdout.write('termd listening on http://127.0.0.1:' + server.address().port + '\n');
});
`;

/** Writes the fake termd into `dir` and returns the path of an executable wrapper (`termd`). */
export function writeFakeTermd(dir: string): string {
  const js = path.join(dir, 'fake-termd.js');
  fs.writeFileSync(js, FAKE_TERMD_JS);
  const bin = path.join(dir, 'termd');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return bin;
}

const hosts: RelaytermHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
});

function makeHost(dir: string, extra: Partial<ConstructorParameters<typeof RelaytermHost>[0]> = {}): RelaytermHost {
  const host = new RelaytermHost({ relayDir: path.join(dir, '.relay'), runId: 'r1', binary: writeFakeTermd(dir), ...extra });
  hosts.push(host);
  return host;
}

const requestsOf = async (host: RelaytermHost) => (await (await fetch(`${host.baseUrl}/__requests`)).json()) as Array<{ method: string; url: string; auth?: string; body?: unknown }>;

describe('relayterm binary lookup', () => {
  it('prefers RELAY_TERMD, then <root>/target/release/termd, then target/debug/termd, then PATH; throws with a cargo hint when nothing is found', () => {
    const root = tmp();
    const empty = tmp();
    expect(() => findTermdBinary({ env: { PATH: empty }, repoRoot: root })).toThrow(/termd binary not found.*cargo build -p termd/);
    fs.mkdirSync(path.join(root, 'target', 'debug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'target', 'debug', 'termd'), '', { mode: 0o755 });
    expect(findTermdBinary({ env: { PATH: empty }, repoRoot: root })).toBe(path.join(root, 'target', 'debug', 'termd'));
    fs.mkdirSync(path.join(root, 'target', 'release'), { recursive: true });
    fs.writeFileSync(path.join(root, 'target', 'release', 'termd'), '', { mode: 0o755 });
    expect(findTermdBinary({ env: { PATH: empty }, repoRoot: root })).toBe(path.join(root, 'target', 'release', 'termd'));
    const onPath = tmp();
    fs.writeFileSync(path.join(onPath, 'termd'), '', { mode: 0o755 });
    expect(findTermdBinary({ env: { PATH: onPath }, repoRoot: empty })).toBe(path.join(onPath, 'termd'));
    const explicit = path.join(tmp(), 'my-termd');
    fs.writeFileSync(explicit, '', { mode: 0o755 });
    expect(findTermdBinary({ env: { RELAY_TERMD: explicit, PATH: onPath }, repoRoot: root })).toBe(explicit);
    expect(() => findTermdBinary({ env: { RELAY_TERMD: '/nope/termd', PATH: onPath }, repoRoot: root })).toThrow(/RELAY_TERMD.*\/nope\/termd/);
  });

  it('config accepts RELAY_HOST=relayterm and createTerminalHost("relayterm") returns the host (construction fails without a binary)', () => {
    expect(loadConfig({ RELAY_HOST: 'relayterm', RELAY_REPO: '/r' }).host).toBe('relayterm');
    const dir = tmp();
    const host = createTerminalHost('relayterm', { relayDir: path.join(dir, '.relay'), runId: 'r1', binary: writeFakeTermd(dir) });
    expect(host.kind).toBe('relayterm');
    expect(host).toBeInstanceOf(RelaytermHost);
    expect(() => createTerminalHost('relayterm', { relayDir: '/x', runId: 'r1', env: { PATH: tmp() }, repoRoot: tmp() })).toThrow(/cargo build -p termd/);
    expect(() => createTerminalHost('relayterm', {})).toThrow(/relayDir/);
  });
});

describe('relayterm host', () => {
  it('start() spawns termd with the documented flags and parses the listening line', async () => {
    const dir = tmp();
    const host = makeHost(dir);
    const { baseUrl } = await host.start();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(host.baseUrl).toBe(baseUrl);
    const metrics = await (await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${host.token}` } })).json() as { argv: string[] };
    expect(metrics.argv).toEqual(['--listen', '127.0.0.1:0', '--token', host.token, '--cast-dir', path.join(dir, '.relay', 'runs', 'r1', 'casts')]);
    expect(host.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('spawn posts the documented body (task_id, prompt, cols, rows) with the termd token and returns relay:<n>', async () => {
    const dir = tmp();
    const host = makeHost(dir);
    const { paneId } = await host.spawn({ name: 'backend', cwd: '/w', argv: ['claude', '--x'], env: { A: '1' }, prompt: 'go', taskId: 't-1' });
    expect(paneId).toBe('relay:1');
    const reqs = await requestsOf(host);
    const post = reqs.find((r) => r.method === 'POST' && r.url === '/panes');
    expect(post).toBeDefined();
    expect(post!.auth).toBe(`Bearer ${host.token}`);
    expect(post!.body).toEqual({ name: 'backend', argv: ['claude', '--x'], cwd: '/w', env: { A: '1' }, prompt: 'go', task_id: 't-1', cols: 120, rows: 40 });
    const second = await host.spawn({ name: 'planner', cwd: '/w', argv: ['sh'], env: {} });
    expect(second.paneId).toBe('relay:2');
    const posts = (await requestsOf(host)).filter((r) => r.method === 'POST' && r.url === '/panes');
    expect(posts[1]!.body).toEqual({ name: 'planner', argv: ['sh'], cwd: '/w', env: {}, cols: 120, rows: 40 });
  });

  it('a 502 from termd rethrows as "agent prompt failed: …"', async () => {
    const host = makeHost(tmp());
    await expect(host.spawn({ name: 'backend', cwd: '/w', argv: ['sh'], env: {}, prompt: 'FAIL please' }))
      .rejects.toThrow(/^agent prompt failed: no prompt on screen within 30000 ms .*; pane relay:1 left open for diagnosis$/);
  });

  it('focus / isAlive / kill map onto the termd routes; isAlive is false for a 404', async () => {
    const host = makeHost(tmp());
    const { paneId } = await host.spawn({ name: 'a', cwd: '/w', argv: ['sh'], env: {} });
    await host.focus(paneId);
    expect(await host.isAlive(paneId)).toBe(true);
    expect(await host.isAlive('relay:99')).toBe(false);
    await host.kill(paneId);
    expect(await host.isAlive(paneId)).toBe(false);
    await expect(host.kill('relay:99')).rejects.toThrow(/relay:99 not found/);
    const urls = (await requestsOf(host)).map((r) => `${r.method} ${r.url}`);
    expect(urls).toContain(`POST /panes/${paneId}/focus`);
    expect(urls).toContain(`GET /panes/${paneId}`);
    expect(urls).toContain(`POST /panes/${paneId}/kill`);
  });

  it('setNextPane before start becomes --first-pane; after start it is a no-op with a warning', async () => {
    const dir = tmp();
    const warnings: string[] = [];
    const host = makeHost(dir, { log: (m) => warnings.push(m) });
    host.setNextPane(7);
    host.setNextPane(3);
    const { paneId } = await host.spawn({ name: 'a', cwd: '/w', argv: ['sh'], env: {} });
    expect(paneId).toBe('relay:7');
    const metrics = await (await fetch(`${host.baseUrl}/metrics`, { headers: { authorization: `Bearer ${host.token}` } })).json() as { argv: string[] };
    expect(metrics.argv.slice(-2)).toEqual(['--first-pane', '7']);
    host.setNextPane(20);
    expect(warnings.some((w) => /setNextPane\(20\).*termd already running/.test(w))).toBe(true);
    expect((await host.spawn({ name: 'b', cwd: '/w', argv: ['sh'], env: {} })).paneId).toBe('relay:8');
  });

  it('stop() terminates the child (SIGTERM), SIGKILL after the grace period when it ignores SIGTERM', async () => {
    const polite = makeHost(tmp());
    await polite.start();
    const pid = polite.pid!;
    expect(pid).toBeGreaterThan(0);
    await polite.stop();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(polite.isAlive('relay:1')).rejects.toThrow(/relayterm host stopped/);

    const stubborn = makeHost(tmp(), { killGraceMs: 200, env: { ...process.env, FAKE_TERMD_IGNORE_SIGTERM: '1' } });
    await stubborn.start();
    const stubbornPid = stubborn.pid!;
    const t0 = Date.now();
    await stubborn.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(() => process.kill(stubbornPid, 0)).toThrow();
  });

  it('termd exiting unexpectedly makes every later call reject with the exit code and the last stderr lines', async () => {
    const host = makeHost(tmp());
    await expect(host.spawn({ name: 'crash', cwd: '/w', argv: ['sh'], env: {} })).rejects.toThrow(/termd exited \(code 3\)/);
    await expect(host.isAlive('relay:1')).rejects.toThrow(/termd exited \(code 3\): [\s\S]*fatal: simulated crash/);
    await expect(host.spawn({ name: 'x', cwd: '/w', argv: ['sh'], env: {} })).rejects.toThrow(/termd exited \(code 3\)/);
  });

  it('start() rejects when termd exits before printing the listening line, or never prints it within the timeout', async () => {
    const dying = makeHost(tmp(), { env: { ...process.env, FAKE_TERMD_EXIT_CODE: '2' } });
    await expect(dying.start()).rejects.toThrow(/termd exited \(code 2\): [\s\S]*boom: cannot start/);
    const silent = makeHost(tmp(), { env: { ...process.env, FAKE_TERMD_SILENT: '1' }, startTimeoutMs: 300 });
    await expect(silent.start()).rejects.toThrow(/no "termd listening on" line within 300 ms/);
  });

  it('killAll kills every alive pane through termd and then stops it', async () => {
    const host = makeHost(tmp());
    const a = await host.spawn({ name: 'a', cwd: '/w', argv: ['sh'], env: {} });
    const b = await host.spawn({ name: 'b', cwd: '/w', argv: ['sh'], env: {} });
    await host.kill(b.paneId);
    const baseUrl = host.baseUrl!;
    const pid = host.pid!;
    await host.killAll();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(host.baseUrl).toBeUndefined();
    await expect(fetch(`${baseUrl}/__requests`)).rejects.toThrow();
    expect(a.paneId).toBe('relay:1');
  });
});

/** Where the real binary would be, or undefined (the integration test is skipped with a reason). */
function realTermd(): string | undefined {
  try {
    return findTermdBinary({ env: process.env, repoRoot: ROOT });
  } catch {
    return undefined;
  }
}

describe('relayterm real termd', () => {
  const binary = realTermd();
  const run = binary ? it : it.skip;
  run(binary ? `drives the real termd at ${binary}: spawn with prompt, isAlive, kill, stop` : 'skipped: termd binary not found (set RELAY_TERMD or run `cargo build -p termd`)', async () => {
    const dir = tmp();
    const host = new RelaytermHost({ relayDir: path.join(dir, '.relay'), runId: 'real', binary: binary! });
    hosts.push(host);
    const { baseUrl } = await host.start();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await (await fetch(`${baseUrl}/health`)).json();
    expect(health).toMatchObject({ ok: true });
    // A fake prompt shell: shows `> `, reads a line, echoes it back and stays alive.
    const { paneId } = await host.spawn({ name: 'shell', cwd: dir, argv: ['sh', '-c', 'printf "> "; read x; echo "got:$x"; sleep 30'], env: {}, prompt: 'hello termd', taskId: 't-real' });
    expect(paneId).toBe('relay:1');
    expect(await host.isAlive(paneId)).toBe(true);
    const info = await (await fetch(`${baseUrl}/panes/${paneId}`, { headers: { authorization: `Bearer ${host.token}` } })).json() as { task_id?: string; role: string; cast_path?: string };
    expect(info.task_id).toBe('t-real');
    expect(info.role).toBe('shell');
    expect(info.cast_path).toBe(path.join(dir, '.relay', 'runs', 'real', 'casts', `${paneId}.cast`));
    const screen = await (await fetch(`${baseUrl}/panes/${paneId}/screen?source=recent&lines=20`, { headers: { authorization: `Bearer ${host.token}` } })).json() as { lines: string[] };
    expect(screen.lines.join('\n')).toContain('got:hello termd');
    await host.kill(paneId);
    expect(await host.isAlive(paneId)).toBe(false);
    expect(fs.existsSync(info.cast_path!)).toBe(true);
    const pid = host.pid!;
    await host.stop();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});

/** SIGTERM the detached child's whole process group (`npx` → `sh` → `node`), see http/boot.test.ts. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
}

async function bootRelayd(env: Record<string, string>): Promise<{ url: string; token: string; output: () => string; stop: () => Promise<void> }> {
  const child = execa('npx', ['tsx', 'apps/relayd/src/index.ts'], { cwd: ROOT, env: { RELAY_PORT: '0', ...env }, reject: false, all: true, detached: true });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line within 10 s; output so far:\n${output}`)), 10_000);
    child.all!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const m = output.match(/relayd listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    });
    void child.then(() => { clearTimeout(timer); reject(new Error(`relayd exited early:\n${output}`)); });
  });
  const token = /relayd token: ([0-9a-f]{32})/.exec(output)?.[1] ?? '';
  return {
    url, token, output: () => output,
    stop: async () => { killGroup(child.pid); await child; },
  };
}

describe('relayterm boot', () => {
  it('RELAY_HOST=relayterm RELAY_TERMD=<fake> serves GET /panes through the proxy (session token required) and on RELAY_RESUME=latest passes --first-pane one past the highest recorded pane', async () => {
    const repo = tmp();
    const bin = writeFakeTermd(tmp());
    const argvFile = path.join(tmp(), 'argv.json');
    const first = await bootRelayd({ RELAY_HOST: 'relayterm', RELAY_TERMD: bin, RELAY_REPO: repo, RELAY_RUN_ID: 'boot-relayterm', FAKE_TERMD_ARGV_FILE: argvFile });
    try {
      expect(first.output()).not.toMatch(/fakes for .*host/);
      expect((await fetch(`${first.url}/panes`)).status).toBe(401);
      const panes = await fetch(`${first.url}/panes`, { headers: { authorization: `Bearer ${first.token}` } });
      expect(panes.status).toBe(200);
      expect(await panes.text()).toBe('{"panes":[]}');
      const metrics = await (await fetch(`${first.url}/metrics`, { headers: { authorization: `Bearer ${first.token}` } })).json() as { host: string };
      expect(metrics.host).toBe('relayterm');
      const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
      expect(argv).not.toContain('--first-pane');
      expect(argv.slice(0, 2)).toEqual(['--listen', '127.0.0.1:0']);
      expect(argv[argv.indexOf('--cast-dir') + 1]).toBe(path.join(repo, '.relay', 'runs', 'boot-relayterm', 'casts'));
      // Something to resume: a mission (so events.jsonl is non-empty) and a recorded pane relay:6.
      const created = await fetch(`${first.url}/missions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, title: 'resume me' }) });
      expect(created.status).toBe(200);
    } finally {
      await first.stop();
    }
    const runDir = path.join(repo, '.relay', 'runs', 'boot-relayterm');
    fs.writeFileSync(path.join(runDir, 'workspace.json'), JSON.stringify({
      run_id: 'boot-relayterm', repo, missions: [],
      panes: [{ pane_id: 'relay:6', task_id: 't-old', role: 'old', runtime: 'claude-code', cwd: repo, session_id: 's', config_dir: '/c', alive: false, spawned_at: new Date().toISOString() }],
    }));
    fs.rmSync(argvFile);
    const second = await bootRelayd({ RELAY_HOST: 'relayterm', RELAY_TERMD: bin, RELAY_REPO: repo, RELAY_RESUME: 'latest', FAKE_TERMD_ARGV_FILE: argvFile });
    try {
      // The resume summary is logged after the listening line: wait for it.
      const t0 = Date.now();
      while (!/resumed run boot-relayterm/.test(second.output())) {
        if (Date.now() - t0 > 5000) throw new Error(`no "resumed run" line within 5 s:\n${second.output()}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as string[];
      expect(argv.slice(-2)).toEqual(['--first-pane', '7']);
      expect((await fetch(`${second.url}/panes`, { headers: { authorization: `Bearer ${second.token}` } })).status).toBe(200);
    } finally {
      await second.stop();
    }
  }, 40_000);
});
