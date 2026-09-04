/**
 * Constrained execution for acceptance-criterion `command` checks (docs/security.md).
 *
 * A check runs as `sh -c <run>` in the task's worktree with an environment built from an allow-list —
 * never the daemon's `process.env`, which carries API keys and the session token. On macOS the shell is
 * additionally wrapped in `sandbox-exec` with a profile that denies all network access and allows writes
 * only under the worktree, the evidence directory, the temp dirs and a scratch HOME under `<relayDir>/home`.
 * Elsewhere the check runs unsandboxed (once logged) but still with the minimal environment.
 * Output is capped at 1 MiB (tail kept) and the whole process group is killed on timeout.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OUTPUT_CAP_BYTES = 1024 * 1024;
export const TRUNCATION_MARKER = `[relayd: output truncated to the last ${OUTPUT_CAP_BYTES} bytes]\n`;

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SHELL = '/bin/sh';
/** Daemon variables copied verbatim when set. HOME and TMPDIR are always replaced; CI is always `1`. */
const PASS_THROUGH = ['PATH', 'LANG', 'TERM', 'NODE_ENV'] as const;
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export type DaemonEnv = Record<string, string | undefined>;

export interface CheckEnvRoots {
  home: string;
  tmpdir: string;
}

/** The environment a check sees: the allow-list plus names from `RELAY_CHECK_ENV_ALLOW` (comma list). */
export function buildCheckEnv(daemonEnv: DaemonEnv, roots: CheckEnvRoots): Record<string, string> {
  const env: Record<string, string> = { PATH: daemonEnv.PATH ?? DEFAULT_PATH, HOME: roots.home, TMPDIR: roots.tmpdir };
  for (const name of PASS_THROUGH) {
    const value = daemonEnv[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of (daemonEnv.RELAY_CHECK_ENV_ALLOW ?? '').split(',').map((n) => n.trim()).filter(Boolean)) {
    const value = daemonEnv[name];
    if (value !== undefined) env[name] = value;
  }
  env.CI = '1';
  return env;
}

export function sandboxExecAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
}

const sbplString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Seatbelt profile: everything allowed except network and writes outside `writableRoots`. */
export function sandboxProfile(writableRoots: string[]): string {
  const roots = [...new Set(writableRoots)].map((root) => `(subpath ${sbplString(root)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/std"))',
    `(allow file-write* ${roots})`,
    '',
  ].join('\n');
}

export interface CheckSandboxOptions {
  relayDir: string;
  /** The daemon's environment; only allow-listed names reach the check. Defaults to `process.env`. */
  env?: DaemonEnv;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

export interface RunCheckOptions {
  run: string;
  cwd: string;
  timeoutMs: number;
  /** Extra directories the check may write to (the evidence dir). */
  writable?: string[];
}

export interface RunCheckResult {
  /** stdout and stderr interleaved in arrival order; at most 1 MiB plus the marker. */
  output: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  sandboxed: boolean;
}

export interface CheckSandbox {
  sandboxed: boolean;
  runCheck(options: RunCheckOptions): Promise<RunCheckResult>;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** A linked git worktree writes its index and objects under the main repository's `.git`; allow those. */
function gitDirs(cwd: string): string[] {
  const dotGit = path.join(cwd, '.git');
  try {
    if (!fs.statSync(dotGit).isFile()) return [];
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!match) return [];
    const gitDir = path.resolve(cwd, match[1]!.trim());
    const dirs = [gitDir];
    const commonFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonFile)) dirs.push(path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()));
    return dirs;
  } catch {
    return [];
  }
}

/**
 * relayd shares the repository's `node_modules` with each worktree through a symlink (git-worktrees.ts). Tools such
 * as Vite write scratch files inside it (`node_modules/.vite-temp`), which resolve to the link target outside the
 * worktree; allow that target so `vitest` can start under the sandbox.
 */
function linkedNodeModules(cwd: string): string[] {
  const link = path.join(cwd, 'node_modules');
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return [];
    return [fs.realpathSync(link)];
  } catch {
    return [];
  }
}

function withRealpaths(dirs: string[]): string[] {
  return [...new Set(dirs.flatMap((dir) => [dir, realpathOrSelf(dir)]))];
}

class OutputBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes > OUTPUT_CAP_BYTES * 2) this.compact();
  }

  private compact(): void {
    const tail = Buffer.concat(this.chunks).subarray(-OUTPUT_CAP_BYTES);
    this.chunks = [Buffer.from(tail)];
    this.bytes = tail.length;
    this.truncated = true;
  }

  text(): string {
    let all = Buffer.concat(this.chunks);
    if (all.length > OUTPUT_CAP_BYTES) {
      all = all.subarray(-OUTPUT_CAP_BYTES);
      this.truncated = true;
    }
    return this.truncated ? TRUNCATION_MARKER + all.toString('utf8') : all.toString('utf8');
  }
}

export function createCheckSandbox(options: CheckSandboxOptions): CheckSandbox {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const log = options.log ?? ((message) => console.error(`relayd: ${message}`));
  const home = path.join(options.relayDir, 'home');
  const tmpdir = os.tmpdir();

  let sandboxed = false;
  if (env.RELAY_CHECK_SANDBOX === 'off') log('check sandbox: disabled by RELAY_CHECK_SANDBOX=off');
  else if (!sandboxExecAvailable(platform)) log(platform === 'darwin' ? `check sandbox: not available on ${platform} (${SANDBOX_EXEC} missing)` : `check sandbox: not available on ${platform}`);
  else sandboxed = true;

  const runCheck = (run: RunCheckOptions): Promise<RunCheckResult> => new Promise((resolve) => {
    fs.mkdirSync(home, { recursive: true });
    const checkEnv = buildCheckEnv(env, { home, tmpdir });
    let argv = [SHELL, '-c', run.run];
    if (sandboxed) {
      const writable = withRealpaths([
        run.cwd, ...(run.writable ?? []), home, tmpdir, '/tmp', '/var/tmp', ...gitDirs(run.cwd), ...linkedNodeModules(run.cwd),
      ]);
      argv = [SANDBOX_EXEC, '-p', sandboxProfile(writable), ...argv];
    }
    const output = new OutputBuffer();
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output: output.text(), exitCode, timedOut, truncated: output.truncated, sandboxed });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: run.cwd, env: checkEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      output.push(Buffer.from(`${(error as Error).message}\n`));
      resolve({ output: output.text(), exitCode: -1, timedOut: false, truncated: output.truncated, sandboxed });
      return;
    }
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, run.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk));
    child.on('error', (error) => {
      output.push(Buffer.from(`${error.message}\n`));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });

  return { sandboxed, runCheck };
}
