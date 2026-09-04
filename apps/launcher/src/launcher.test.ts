import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PORT } from '@relay/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArgs, runLauncher, type ChildProcessLike, type SpawnFunction } from './launcher.js';

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
      host: 'relay',
      noSpawn: false,
    });
  });

  it('parses every up flag and resolves filesystem paths', () => {
    expect(parseArgs([
      'up', '--repo', 'project', '--port', '9001', '--host', 'herdr',
      '--dir', 'state', '--replay', 'fixtures/run.jsonl', '--no-spawn',
    ], cwd)).toEqual({
      command: 'up',
      repo: path.join(cwd, 'project'),
      relayDir: path.join(cwd, 'state'),
      relayDirExplicit: true,
      port: 9001,
      host: 'herdr',
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
      '--repo', 'project', '--dir', 'state', '--port', '9444', '--host', 'tmux',
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
          RELAY_HOST: 'tmux',
          RELAY_RESUME: 'latest',
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
