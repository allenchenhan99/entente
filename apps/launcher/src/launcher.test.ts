import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PORT } from '@relay/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArgs, runLauncher, runTui, type ChildProcessLike, type SpawnFunction } from './launcher.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function childProcess(pid: number) {
  const child = new EventEmitter() as ChildProcessLike;
  child.pid = pid;
  child.unref = vi.fn();
  child.kill = vi.fn(() => true);
  return child;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseArgs', () => {
  const cwd = path.resolve('/tmp', 'relay-launcher-repo');

  it('defaults to up in the current repository', () => {
    expect(parseArgs([], cwd)).toEqual({
      command: 'up',
      repo: cwd,
      relayDir: path.join(cwd, '.relay'),
      port: DEFAULT_PORT,
      noSpawn: false,
    });
  });

  it('parses --tui and rejects unknown clients', () => {
    expect(parseArgs(['--tui', 'ink'], cwd)).toMatchObject({ command: 'up', tui: 'ink' });
    expect(() => parseArgs(['--tui', 'web'], cwd)).toThrow(/--tui/);
  });

  it('parses every up flag and resolves filesystem paths', () => {
    expect(parseArgs([
      'up', '--repo', 'project', '--port', '9001', '--host', 'relayterm',
      '--dir', 'state', '--replay', 'fixtures/run.jsonl', '--no-spawn',
    ], cwd)).toEqual({
      command: 'up',
      repo: path.join(cwd, 'project'),
      relayDir: path.join(cwd, 'state'),
      relayDirExplicit: true,
      port: 9001,
      host: 'relayterm',
      replay: 'fixtures/run.jsonl',
      noSpawn: true,
    });
  });

  it.each(['status', 'down'] as const)('parses the %s subcommand', (command) => {
    expect(parseArgs([command, '--repo', 'project', '--port', '8123'], cwd)).toMatchObject({
      command,
      repo: path.join(cwd, 'project'),
      relayDir: path.join(cwd, 'project', '.relay'),
      port: 8123,
    });
  });

  it('recognizes help without requiring a daemon', () => {
    expect(parseArgs(['--help'], cwd)).toEqual({ command: 'help' });
  });

  it('rejects unknown flags, commands, hosts, and ports as usage errors', () => {
    expect(() => parseArgs(['--wat'], cwd)).toThrow(/unknown option/i);
    expect(() => parseArgs(['restart'], cwd)).toThrow(/unknown command/i);
    expect(() => parseArgs(['--host', 'fake'], cwd)).toThrow(/--host/);
    expect(() => parseArgs(['--port', '0'], cwd)).toThrow(/--port/);
  });
});

describe('up', () => {
  it('reuses a healthy relayd and starts only the foreground TUI with its URL and token', async () => {
    const repo = temporaryDirectory();
    const workspaceRoot = temporaryDirectory();
    const relayDir = path.join(repo, '.relay');
    fs.mkdirSync(relayDir);
    fs.writeFileSync(path.join(relayDir, 'session.token'), 'existing-token\n');
    const tuiChild = childProcess(7002);
    const spawn = vi.fn(() => {
      queueMicrotask(() => tuiChild.emit('exit', 7, null));
      return tuiChild;
    }) as unknown as SpawnFunction;
    const fetch = vi.fn(async () => jsonResponse({ ok: true, version: '0.0.1' }));

    const code = await runLauncher([], {
      cwd: repo,
      workspaceRoot,
      fetch,
      spawn,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(code).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      '--import', 'tsx', path.join(workspaceRoot, 'apps/tui/src/index.tsx'),
      '--url', `http://127.0.0.1:${DEFAULT_PORT}`,
      '--token', 'existing-token',
    ], expect.objectContaining({ detached: false, stdio: 'inherit' }));
  });

  it('auto-selects our own terminal base (relayterm + relay-tui) when the Rust binaries are built', async () => {
    const cwd = temporaryDirectory();
    const repo = path.join(cwd, 'project');
    const relayDir = path.join(repo, '.relay');
    const workspaceRoot = temporaryDirectory();
    fs.mkdirSync(relayDir, { recursive: true });
    fs.writeFileSync(path.join(relayDir, 'session.token'), 'rust-token');
    fs.mkdirSync(path.join(workspaceRoot, 'target', 'debug'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'target', 'debug', 'termd'), '');
    fs.writeFileSync(path.join(workspaceRoot, 'target', 'debug', 'relay-tui'), '');
    const daemon = childProcess(7001);
    const tui = childProcess(7002);
    const spawn = vi.fn((_command, _args, options) => {
      if (options.detached) return daemon;
      queueMicrotask(() => tui.emit('exit', 0, null));
      return tui;
    }) as unknown as SpawnFunction;
    let healthAttempts = 0;
    const fetch = vi.fn(async () => {
      healthAttempts += 1;
      if (healthAttempts < 2) throw new Error('ECONNREFUSED');
      return jsonResponse({ ok: true, version: '0.0.1' });
    });
    let clock = 0;

    const code = await runLauncher(['--repo', 'project'], {
      cwd, workspaceRoot, env: { PATH: '/test/bin' }, fetch, spawn,
      now: () => clock, sleep: vi.fn(async (ms: number) => { clock += ms; }), stdout: vi.fn(), stderr: vi.fn(),
    });

    expect(code).toBe(0);
    const relaydCall = spawn.mock.calls.find((call) => call[2].detached);
    expect(relaydCall?.[2].env).toMatchObject({
      RELAY_HOST: 'relayterm',
      RELAY_TERMD: path.join(workspaceRoot, 'target', 'debug', 'termd'),
    });
    expect(spawn.mock.calls[1]?.[0]).toBe(path.join(workspaceRoot, 'target', 'debug', 'relay-tui'));
    expect(spawn.mock.calls[1]?.[1]).toEqual([
      '--url', `http://127.0.0.1:${DEFAULT_PORT}`, '--token', 'rust-token', '--repo', repo,
    ]);
  });

  it('--tui ink keeps the Ink client and --host relay the TypeScript host even when the binaries exist', async () => {
    const repo = temporaryDirectory();
    const workspaceRoot = temporaryDirectory();
    fs.mkdirSync(path.join(repo, '.relay'));
    fs.writeFileSync(path.join(repo, '.relay', 'session.token'), 'ink-token');
    fs.mkdirSync(path.join(workspaceRoot, 'target', 'release'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'target', 'release', 'termd'), '');
    fs.writeFileSync(path.join(workspaceRoot, 'target', 'release', 'relay-tui'), '');
    const tui = childProcess(7002);
    const spawn = vi.fn(() => {
      queueMicrotask(() => tui.emit('exit', 0, null));
      return tui;
    }) as unknown as SpawnFunction;
    const fetch = vi.fn(async () => jsonResponse({ ok: true, version: '0.0.1' }));

    await runLauncher(['--tui', 'ink', '--host', 'relay'], { cwd: repo, workspaceRoot, fetch, spawn, stdout: vi.fn(), stderr: vi.fn() });

    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      '--import', 'tsx', path.join(workspaceRoot, 'apps/tui/src/index.tsx'),
      '--url', `http://127.0.0.1:${DEFAULT_PORT}`, '--token', 'ink-token',
    ], expect.objectContaining({ stdio: 'inherit' }));
  });

  it('spawns relayd once after failed health checks, waits, writes its pid, and starts the TUI', async () => {
    const cwd = temporaryDirectory();
    const repo = path.join(cwd, 'project');
    const relayDir = path.join(cwd, 'state');
    const workspaceRoot = temporaryDirectory();
    fs.mkdirSync(repo);
    fs.mkdirSync(relayDir);
    fs.writeFileSync(path.join(relayDir, 'session.token'), 'spawned-token');
    const daemon = childProcess(7001);
    const tui = childProcess(7002);
    const spawn = vi.fn((_command, _args, options) => {
      if (options.detached) return daemon;
      queueMicrotask(() => tui.emit('exit', 0, null));
      return tui;
    }) as unknown as SpawnFunction;
    let healthAttempts = 0;
    const fetch = vi.fn(async () => {
      healthAttempts += 1;
      if (healthAttempts < 3) throw new Error('ECONNREFUSED');
      return jsonResponse({ ok: true, version: '0.0.1' });
    });
    let clock = 0;
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });

    const code = await runLauncher([
      '--repo', 'project', '--dir', 'state', '--port', '9444', '--host', 'relay',
    ], {
      cwd,
      workspaceRoot,
      env: { PATH: '/test/bin' },
      fetch,
      spawn,
      now: () => clock,
      sleep,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(spawn).toHaveBeenCalledTimes(2);
    const relaydCall = spawn.mock.calls.find((call) => call[2].detached);
    expect(relaydCall).toEqual([
      process.execPath,
      ['--import', 'tsx', path.join(workspaceRoot, 'apps/relayd/src/index.ts')],
      expect.objectContaining({
        detached: true,
        env: {
          PATH: '/test/bin',
          RELAY_REPO: repo,
          RELAY_DIR: relayDir,
          RELAY_PORT: '9444',
          RELAY_HOST: 'relay',
          RELAY_RESUME: 'auto',
        },
      }),
    ]);
    expect(relaydCall?.[2].stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect(daemon.unref).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(relayDir, 'relayd.pid'), 'utf8')).toBe('7001\n');
    expect(spawn.mock.calls[1]?.[1]).toEqual([
      '--import', 'tsx', path.join(workspaceRoot, 'apps/tui/src/index.tsx'),
      '--url', 'http://127.0.0.1:9444', '--token', 'spawned-token',
    ]);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('starts replay directly without a health check, token read, or daemon spawn', async () => {
    const cwd = temporaryDirectory();
    const workspaceRoot = temporaryDirectory();
    const tui = childProcess(7002);
    const spawn = vi.fn(() => {
      queueMicrotask(() => tui.emit('exit', 0, null));
      return tui;
    }) as unknown as SpawnFunction;
    const fetch = vi.fn();

    const code = await runLauncher(['--replay', 'fixtures/demo.jsonl'], {
      cwd,
      workspaceRoot,
      fetch,
      spawn,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      '--import', 'tsx', path.join(workspaceRoot, 'apps/tui/src/index.tsx'),
      '--replay', 'fixtures/demo.jsonl',
    ], expect.objectContaining({ detached: false, stdio: 'inherit' }));
  });

  it('up keeps the TUI foreground child attached and forwards termination signals', async () => {
    const workspaceRoot = temporaryDirectory();
    const tui = childProcess(7002);
    const signalBus = new EventEmitter();
    const signals = {
      on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => { signalBus.on(signal, listener); },
      off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => { signalBus.off(signal, listener); },
    };
    const result = runTui(
      { workspaceRoot, replay: 'run.jsonl' },
      { spawn: vi.fn(() => tui) as unknown as SpawnFunction, fs, signals },
    );

    signalBus.emit('SIGTERM');
    expect(tui.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    tui.emit('exit', null, 'SIGTERM');

    await expect(result).resolves.toBe(143);
    expect(signalBus.listenerCount('SIGINT')).toBe(0);
    expect(signalBus.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('timeout and no-spawn', () => {
  it('timeout prints only the last 20 relayd log lines and never starts the TUI', async () => {
    const repo = temporaryDirectory();
    const workspaceRoot = temporaryDirectory();
    const relayDir = path.join(repo, '.relay');
    fs.mkdirSync(relayDir);
    fs.writeFileSync(
      path.join(relayDir, 'relayd.log'),
      `${Array.from({ length: 25 }, (_, index) => `log-${index + 1}`).join('\n')}\n`,
    );
    const daemon = childProcess(7001);
    const spawn = vi.fn(() => daemon) as unknown as SpawnFunction;
    const fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    let clock = 0;
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const stderr = vi.fn();

    const code = await runLauncher([], {
      cwd: repo,
      workspaceRoot,
      fetch,
      spawn,
      now: () => clock,
      sleep,
      stdout: vi.fn(),
      stderr,
    });

    expect(code).toBe(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[2].detached).toBe(true);
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([
      'entente: relayd did not become healthy within 15 seconds',
      ...Array.from({ length: 20 }, (_, index) => `log-${index + 6}`),
    ]);
  });

  it('no-spawn exits with a one-line hint when no daemon answers', async () => {
    const stderr = vi.fn();
    const spawn = vi.fn() as unknown as SpawnFunction;

    const code = await runLauncher(['--no-spawn'], {
      cwd: temporaryDirectory(),
      workspaceRoot: temporaryDirectory(),
      fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      spawn,
      stdout: vi.fn(),
      stderr,
    });

    expect(code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith('entente: relayd is not running; remove --no-spawn to start it');
  });

  it('no-spawn refuses a port answered by something other than relayd', async () => {
    const stderr = vi.fn();
    const spawn = vi.fn() as unknown as SpawnFunction;

    const code = await runLauncher(['--no-spawn', '--port', '8123'], {
      cwd: temporaryDirectory(),
      workspaceRoot: temporaryDirectory(),
      fetch: vi.fn(async () => new Response('hello', { status: 200 })),
      spawn,
      stdout: vi.fn(),
      stderr,
    });

    expect(code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith('entente: port 8123 is busy, but the responder is not relayd');
  });
});

describe('status and down', () => {
  it('status reports a healthy relayd with its version, pid, and relayDir', async () => {
    const repo = temporaryDirectory();
    const relayDir = path.join(repo, '.relay');
    fs.mkdirSync(relayDir);
    fs.writeFileSync(path.join(relayDir, 'relayd.pid'), '7001\n');
    const stdout = vi.fn();

    const code = await runLauncher(['status'], {
      cwd: repo,
      fetch: vi.fn(async () => jsonResponse({ ok: true, version: '0.0.1' })),
      stdout,
      stderr: vi.fn(),
    });

    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(`relayd healthy version 0.0.1 pid 7001 relayDir ${relayDir}`);
  });

  it('status reports an unhealthy relayd and exits one when no endpoint or pid exists', async () => {
    const repo = temporaryDirectory();
    const stdout = vi.fn();

    const code = await runLauncher(['status'], {
      cwd: repo,
      fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      stdout,
      stderr: vi.fn(),
    });

    expect(code).toBe(1);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(`relayd down version - pid - relayDir ${path.join(repo, '.relay')}`);
  });

  it('down signals a live healthy pid, waits for exit, and removes the pid file', async () => {
    const repo = temporaryDirectory();
    const relayDir = path.join(repo, '.relay');
    const pidFile = path.join(relayDir, 'relayd.pid');
    fs.mkdirSync(relayDir);
    fs.writeFileSync(pidFile, '7001\n');
    let alive = true;
    const processKill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 'SIGTERM') alive = false;
      if (signal === 0 && !alive) throw Object.assign(new Error('not found'), { code: 'ESRCH' });
      return true;
    });
    const stdout = vi.fn();

    const code = await runLauncher(['down'], {
      cwd: repo,
      fetch: vi.fn(async () => jsonResponse({ ok: true, version: '0.0.1' })),
      processKill,
      stdout,
      stderr: vi.fn(),
    });

    expect(code).toBe(0);
    expect(processKill).toHaveBeenCalledWith(7001, 'SIGTERM');
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(stdout).toHaveBeenCalledExactlyOnceWith('relayd stopped pid 7001');
  });

  it('down refuses to signal a live pid when relayd no longer answers health', async () => {
    const repo = temporaryDirectory();
    const relayDir = path.join(repo, '.relay');
    const pidFile = path.join(relayDir, 'relayd.pid');
    fs.mkdirSync(relayDir);
    fs.writeFileSync(pidFile, '7001\n');
    const processKill = vi.fn(() => true);
    const stderr = vi.fn();

    const code = await runLauncher(['down'], {
      cwd: repo,
      fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      processKill,
      stdout: vi.fn(),
      stderr,
    });

    expect(code).toBe(1);
    expect(processKill).toHaveBeenCalledWith(7001, 0);
    expect(processKill).not.toHaveBeenCalledWith(7001, 'SIGTERM');
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(stderr).toHaveBeenCalledExactlyOnceWith('entente: refusing to signal pid 7001 because relayd does not answer on port 7420');
  });

  it('down refuses to signal a dead pid even when a different relayd answers health', async () => {
    const repo = temporaryDirectory();
    const relayDir = path.join(repo, '.relay');
    const pidFile = path.join(relayDir, 'relayd.pid');
    fs.mkdirSync(relayDir);
    fs.writeFileSync(pidFile, '7001\n');
    const processKill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => signal !== 0);
    const stderr = vi.fn();

    const code = await runLauncher(['down'], {
      cwd: repo,
      fetch: vi.fn(async () => jsonResponse({ ok: true, version: '0.0.1' })),
      processKill,
      stdout: vi.fn(),
      stderr,
    });

    expect(code).toBe(1);
    expect(processKill).not.toHaveBeenCalledWith(7001, 'SIGTERM');
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(stderr).toHaveBeenCalledExactlyOnceWith('entente: refusing to signal stale pid 7001');
  });

  it('down waits no more than five seconds and never escalates a stuck process', async () => {
    const repo = temporaryDirectory();
    const relayDir = path.join(repo, '.relay');
    const pidFile = path.join(relayDir, 'relayd.pid');
    fs.mkdirSync(relayDir);
    fs.writeFileSync(pidFile, '7001\n');
    const processKill = vi.fn(() => true);
    let clock = 0;
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const stderr = vi.fn();

    const code = await runLauncher(['down'], {
      cwd: repo,
      fetch: vi.fn(async () => jsonResponse({ ok: true, version: '0.0.1' })),
      processKill,
      now: () => clock,
      sleep,
      stdout: vi.fn(),
      stderr,
    });

    expect(code).toBe(1);
    expect(clock).toBe(5_000);
    expect(processKill).toHaveBeenCalledWith(7001, 'SIGTERM');
    expect(processKill.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(stderr).toHaveBeenCalledExactlyOnceWith('entente: pid 7001 did not exit within 5 seconds');
  });
});

describe('the pane shell startup file', () => {
  it("sources the user's own rc before putting the wrappers in front of it", async () => {
    const workspaceRoot = temporaryDirectory();
    const relayDir = path.join(temporaryDirectory(), '.relay');
    const tui = childProcess(7010);
    const signalBus = new EventEmitter();
    const signals = {
      on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => { signalBus.on(signal, listener); },
      off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => { signalBus.off(signal, listener); },
    };
    const spawn = vi.fn(() => tui) as unknown as SpawnFunction;

    const result = runTui(
      { workspaceRoot, tui: 'rust', binary: path.join(workspaceRoot, 'relay-tui'), url: 'http://127.0.0.1:7420', token: 't', relayDir },
      { spawn, fs, signals },
    );
    tui.emit('exit', 0, null);
    await result;

    const body = fs.readFileSync(path.join(relayDir, 'shell-rc'), 'utf8');
    // Order is the whole point. `~/.bashrc` commonly ends with its own `export PATH="…:$PATH"`, which
    // moves the real binaries back in front of the wrappers; prepending only after it has run is the
    // one ordering that holds, and setting PATH on the child alone does not.
    const sourced = body.indexOf('.bashrc');
    const prepended = body.indexOf('export PATH=');
    expect(sourced).toBeGreaterThan(-1);
    expect(prepended).toBeGreaterThan(sourced);
    expect(body).toContain(path.join('apps', 'shims', 'bin'));

    const env = (spawn as unknown as { mock: { calls: Array<[string, string[], { env: Record<string, string> }]> } }).mock.calls.at(-1)![2].env;
    expect(env.RELAY_SHELL_RC).toBe(path.join(relayDir, 'shell-rc'));
  });
});
