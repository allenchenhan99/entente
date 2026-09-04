import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCheckEnv, createCheckSandbox, sandboxProfile, sandboxExecAvailable, OUTPUT_CAP_BYTES } from './sandbox.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const daemonEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/daemon',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm',
  NODE_ENV: 'production',
  RELAY_SECRET_TEST: 'hunter2',
  ANTHROPIC_API_KEY: 'sk-secret',
  AWS_PROFILE: 'prod',
};

describe('sandbox env', () => {
  it('builds the check environment from the allow-list only, with HOME at the scratch dir and CI=1', () => {
    const env = buildCheckEnv(daemonEnv, { home: '/relay/home', tmpdir: '/tmp/x' });
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/relay/home',
      TMPDIR: '/tmp/x',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm',
      NODE_ENV: 'production',
      CI: '1',
    });
  });

  it('passes through names listed in RELAY_CHECK_ENV_ALLOW and never the rest', () => {
    const env = buildCheckEnv({ ...daemonEnv, RELAY_CHECK_ENV_ALLOW: 'AWS_PROFILE, MISSING_ONE' }, { home: '/h', tmpdir: '/t' });
    expect(env.AWS_PROFILE).toBe('prod');
    expect(env).not.toHaveProperty('MISSING_ONE');
    expect(env).not.toHaveProperty('RELAY_SECRET_TEST');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('RELAY_CHECK_ENV_ALLOW');
  });

  it('runs sh -c in the worktree with only the allow-listed env and a scratch HOME under <relayDir>/home', async () => {
    const relayDir = tempDir();
    const cwd = tempDir();
    const sandbox = createCheckSandbox({ relayDir, env: daemonEnv, log: () => {} });
    const result = await sandbox.runCheck({ run: 'env | sort; pwd; echo "home=$HOME"', cwd, timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.output).toContain('PATH=');
    expect(result.output).toContain('CI=1');
    expect(result.output).not.toContain('RELAY_SECRET_TEST');
    expect(result.output).not.toContain('hunter2');
    expect(result.output).not.toContain('ANTHROPIC_API_KEY');
    expect(result.output).toContain(`\n${fs.realpathSync(cwd)}\n`);
    expect(result.output).toContain(`home=${path.join(relayDir, 'home')}`);
    expect(fs.statSync(path.join(relayDir, 'home')).isDirectory()).toBe(true);
  });

  it('caps captured output at 1 MiB, keeping the tail behind a marker', async () => {
    const relayDir = tempDir();
    const cwd = tempDir();
    const sandbox = createCheckSandbox({ relayDir, env: daemonEnv, log: () => {} });
    // 1 200 lines × 1 001 bytes ≈ 1.2 MB of stdout, last line is "…1199".
    const result = await sandbox.runCheck({
      run: "i=0; while [ $i -lt 1200 ]; do printf '%01000d\\n' $i; i=$((i+1)); done",
      cwd,
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.output.startsWith('[relayd: output truncated to the last 1048576 bytes]\n')).toBe(true);
    expect(result.output.trimEnd().endsWith('1199')).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES + 100);
  });

  it('kills the whole process group on timeout', async () => {
    const relayDir = tempDir();
    const cwd = tempDir();
    const sandbox = createCheckSandbox({ relayDir, env: daemonEnv, log: () => {} });
    const result = await sandbox.runCheck({ run: 'sleep 30 & echo "child=$!"; wait', cwd, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    const child = Number(/child=(\d+)/.exec(result.output)?.[1]);
    expect(child).toBeGreaterThan(0);
    // The background `sleep` was in the check's process group, so it must be gone too.
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 2_000;
    while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
  });

  it('logs once and runs unsandboxed with the minimal env where sandbox-exec is unavailable', async () => {
    const relayDir = tempDir();
    const cwd = tempDir();
    const logs: string[] = [];
    const sandbox = createCheckSandbox({ relayDir, env: daemonEnv, platform: 'linux', log: (m) => logs.push(m) });
    expect(sandbox.sandboxed).toBe(false);
    await sandbox.runCheck({ run: 'true', cwd, timeoutMs: 5_000 });
    const second = await sandbox.runCheck({ run: 'echo "$RELAY_SECRET_TEST"', cwd, timeoutMs: 5_000 });
    expect(second.output.trim()).toBe('');
    expect(logs).toEqual(['check sandbox: not available on linux']);
  });

  it('honours RELAY_CHECK_SANDBOX=off', () => {
    const logs: string[] = [];
    const sandbox = createCheckSandbox({ relayDir: tempDir(), env: { ...daemonEnv, RELAY_CHECK_SANDBOX: 'off' }, platform: 'darwin', log: (m) => logs.push(m) });
    expect(sandbox.sandboxed).toBe(false);
    expect(logs).toEqual(['check sandbox: disabled by RELAY_CHECK_SANDBOX=off']);
  });
});

describe('sandbox network', () => {
  it('writes a profile that denies network and allows writes only under the given roots', () => {
    const profile = sandboxProfile(['/wt', '/evidence']);
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(subpath "/wt")');
    expect(profile).toContain('(subpath "/evidence")');
  });

  it('denies network and writes outside the worktree, evidence dir, TMPDIR and scratch home', async (ctx) => {
    if (!sandboxExecAvailable()) return ctx.skip(`sandbox-exec not available on ${process.platform}`);
    // The relay dir must live outside the (writable) temp tree so `$HOME/..` is really outside; `.relay/` is git-ignored.
    fs.mkdirSync(path.join(process.cwd(), '.relay'), { recursive: true });
    const relayDir = fs.mkdtempSync(path.join(process.cwd(), '.relay', 'sandbox-test-'));
    tempDirs.push(relayDir);
    const cwd = tempDir();
    const evidenceDir = path.join(relayDir, 'evidence', 't-1');
    fs.mkdirSync(evidenceDir, { recursive: true }); // the check runner creates it before running checks
    const sandbox = createCheckSandbox({ relayDir, env: { ...daemonEnv, PATH: process.env.PATH ?? '/usr/bin:/bin' }, log: () => {} });
    expect(sandbox.sandboxed).toBe(true);

    const network = await sandbox.runCheck({ run: 'curl -sS -m 2 https://example.com', cwd, timeoutMs: 10_000 });
    expect(network.exitCode).not.toBe(0);

    const allowed = await sandbox.runCheck({
      run: `touch ./ok && touch /tmp/relay-sandbox-ok && touch "$TMPDIR/relay-sandbox-ok" && touch "$HOME/ok" && touch "${evidenceDir}/ok"`,
      cwd,
      timeoutMs: 10_000,
      writable: [evidenceDir],
    });
    expect(allowed.output).toBe('');
    expect(allowed.exitCode).toBe(0);
    expect(fs.existsSync(path.join(cwd, 'ok'))).toBe(true);
    expect(fs.existsSync(path.join(evidenceDir, 'ok'))).toBe(true);
    fs.rmSync('/tmp/relay-sandbox-ok', { force: true });

    const outside = await sandbox.runCheck({ run: 'touch "$HOME/../outside"', cwd, timeoutMs: 10_000 });
    expect(outside.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(relayDir, 'outside'))).toBe(false);

    const homeDir = await sandbox.runCheck({ run: `touch "${os.homedir()}/relay-sandbox-must-not-exist"`, cwd, timeoutMs: 10_000 });
    expect(homeDir.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(os.homedir(), 'relay-sandbox-must-not-exist'))).toBe(false);
  });

  it('allows writes through the worktree\'s node_modules symlink (Vite writes node_modules/.vite-temp there)', async (ctx) => {
    if (!sandboxExecAvailable()) return ctx.skip(`sandbox-exec not available on ${process.platform}`);
    const relayDir = fs.mkdtempSync(path.join(process.cwd(), '.relay', 'sandbox-test-'));
    tempDirs.push(relayDir);
    const shared = path.join(relayDir, 'shared', 'node_modules'); // stands in for the main checkout's node_modules (outside the temp tree)
    fs.mkdirSync(shared, { recursive: true });
    const cwd = tempDir();
    fs.symlinkSync(shared, path.join(cwd, 'node_modules'), 'dir');
    const sandbox = createCheckSandbox({ relayDir, env: { ...daemonEnv, PATH: process.env.PATH ?? '/usr/bin:/bin' }, log: () => {} });
    const result = await sandbox.runCheck({ run: 'mkdir -p node_modules/.vite-temp && touch node_modules/.vite-temp/x', cwd, timeoutMs: 10_000 });
    expect(result.output).toBe('');
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(shared, '.vite-temp', 'x'))).toBe(true);
    // A worktree without node_modules resolves the nearest ancestor's: that directory is writable too.
    const nested = path.join(path.dirname(shared), 'wt', 'integration');
    fs.mkdirSync(nested, { recursive: true });
    const ancestor = await sandbox.runCheck({ run: 'mkdir -p ../../node_modules/.vite-temp && touch ../../node_modules/.vite-temp/y', cwd: nested, timeoutMs: 10_000 });
    expect(ancestor.exitCode).toBe(0);
    expect(fs.existsSync(path.join(shared, '.vite-temp', 'y'))).toBe(true);
    // Only the link target is opened up, not its parent.
    const parent = await sandbox.runCheck({ run: `touch "${path.dirname(shared)}/sibling"`, cwd, timeoutMs: 10_000 });
    expect(parent.exitCode).not.toBe(0);
    expect(fs.existsSync(path.join(path.dirname(shared), 'sibling'))).toBe(false);
  });
});
