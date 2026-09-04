/**
 * TerminalHost `relayterm`: relayd drives the Rust `termd` (crates/termd, docs/relay-term-spec.md) instead of
 * its in-process TypeScript PTY host. The host spawns `termd` once (lazily on first use, or eagerly via
 * `start()`), delivers prompts through `POST /panes`, and exposes `baseUrl` / `token` so `http/pty-proxy.ts` can
 * forward relayd's `/panes*`, `/pty/*` and `/metrics` routes to it unchanged.
 *
 * Binary lookup: `RELAY_TERMD` → `<repoRoot>/target/release/termd` → `<repoRoot>/target/debug/termd` → `termd`
 * on `PATH` (`repoRoot` = this checkout, where `cargo build -p termd` puts it).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions, TerminalHost } from '../../ports.js';

/** The checkout root (apps/relayd/src/launch/hosts → ../../../../..). */
export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const LISTENING_RE = /termd listening on (http:\/\/[^\s]+)/;
const STDERR_RING_LINES = 20;
/** After a failed request, how long to wait for the child's exit event before reporting "unreachable". */
const EXIT_SETTLE_MS = 500;
/** Default pane size, the same as termd's own default (spec §3). */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export interface FindTermdOptions {
  env?: Record<string, string | undefined>;
  /** Where `target/{release,debug}/termd` is looked up; defaults to this checkout. */
  repoRoot?: string;
}

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

export function findTermdBinary(options: FindTermdOptions = {}): string {
  const env = options.env ?? process.env;
  const root = options.repoRoot ?? SOURCE_ROOT;
  if (env.RELAY_TERMD) {
    if (!isExecutable(env.RELAY_TERMD)) throw new Error(`termd binary not found: RELAY_TERMD=${env.RELAY_TERMD} is not an executable file`);
    return env.RELAY_TERMD;
  }
  const candidates = [path.join(root, 'target', 'release', 'termd'), path.join(root, 'target', 'debug', 'termd')];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'termd'));
  const found = candidates.find(isExecutable);
  if (!found) throw new Error(`termd binary not found (looked at RELAY_TERMD, ${candidates.slice(0, 2).join(', ')} and PATH): run \`cargo build -p termd\` or set RELAY_TERMD`);
  return found;
}

export interface RelaytermHostDeps {
  relayDir: string;
  runId: string;
  /** Path of the termd executable; looked up per `findTermdBinary` when omitted. */
  binary?: string;
  /** Token termd is started with (`--token`); generated when omitted. */
  token?: string;
  /** Environment for the binary lookup and the termd child; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  repoRoot?: string;
  /** Wait this long for the `termd listening on` line. */
  startTimeoutMs?: number;
  /** SIGKILL this long after SIGTERM in `stop()`. */
  killGraceMs?: number;
  log?: (msg: string) => void;
}

interface PostPanesBody {
  name: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  prompt?: string;
  task_id?: string;
  cols: number;
  rows: number;
}

export interface RelaytermSpawnOptions extends SpawnOptions {
  cols?: number;
  rows?: number;
}

type Started = { baseUrl: string };

export class RelaytermHost implements TerminalHost {
  readonly kind = 'relayterm' as const;
  readonly token: string;
  readonly binary: string;
  private readonly castDir: string;
  private readonly env: Record<string, string | undefined>;
  private readonly startTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly log: (msg: string) => void;
  private firstPane: number | undefined;
  private child: ChildProcess | undefined;
  private starting: Promise<Started> | undefined;
  private started: Started | undefined;
  /** Resolves when the child has exited (never, before `start()`). */
  private exited: Promise<void> = new Promise(() => {});
  private readonly stderrRing: string[] = [];
  /** Set once the child is gone: the unexpected-exit message, or `stopped` after `stop()`. */
  private dead: { message: string } | undefined;
  private stopped = false;

  constructor(deps: RelaytermHostDeps) {
    if (!deps.relayDir || !deps.runId) throw new Error('relayterm host: relayDir and runId are required');
    this.env = deps.env ?? process.env;
    this.binary = deps.binary ?? findTermdBinary({ env: this.env, repoRoot: deps.repoRoot });
    this.token = deps.token ?? crypto.randomBytes(16).toString('hex');
    this.castDir = path.join(deps.relayDir, 'runs', deps.runId, 'casts');
    this.startTimeoutMs = deps.startTimeoutMs ?? 10_000;
    this.killGraceMs = deps.killGraceMs ?? 3000;
    this.log = deps.log ?? ((m) => console.error(`relayd: ${m}`));
  }

  /** `http://127.0.0.1:<port>` once termd is listening (undefined before `start()` and after `stop()`). */
  get baseUrl(): string | undefined {
    return this.started?.baseUrl;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Daemon restart: becomes `--first-pane`; ignored (with a warning) once termd runs. */
  setNextPane(n: number): void {
    if (this.starting) {
      this.log(`relayterm: setNextPane(${n}) ignored: termd already running (pane numbering is fixed at start)`);
      return;
    }
    if (this.firstPane === undefined || n > this.firstPane) this.firstPane = n;
  }

  /** Spawns termd (once) and resolves when it printed its listening line. */
  start(): Promise<Started> {
    const gone = this.deadError();
    if (gone) return Promise.reject(gone);
    if (!this.starting) this.starting = this.launch();
    return this.starting;
  }

  private argv(): string[] {
    const argv = ['--listen', '127.0.0.1:0', '--token', this.token, '--cast-dir', this.castDir];
    if (this.firstPane !== undefined) argv.push('--first-pane', String(this.firstPane));
    return argv;
  }

  private launch(): Promise<Started> {
    fs.mkdirSync(this.castDir, { recursive: true });
    const child = spawn(this.binary, this.argv(), { stdio: ['ignore', 'pipe', 'pipe'], env: this.env as NodeJS.ProcessEnv });
    this.child = child;
    this.exited = new Promise<void>((resolve) => child.once('exit', () => setImmediate(resolve)));
    let stderrTail = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString();
      const lines = stderrTail.split('\n');
      stderrTail = lines.pop()!;
      for (const line of lines) {
        this.stderrRing.push(line);
        if (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift();
      }
    });
    return new Promise<Started>((resolve, reject) => {
      let stdout = '';
      let settled = false;
      const timer = setTimeout(() => fail(new Error(`termd: no "termd listening on" line within ${this.startTimeoutMs} ms${this.stderrSuffix()}`)), this.startTimeoutMs);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!this.dead) this.dead = { message: err.message };
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        reject(err);
      };
      child.stdout!.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdout += chunk.toString();
        const m = LISTENING_RE.exec(stdout);
        if (!m) return;
        settled = true;
        clearTimeout(timer);
        this.started = { baseUrl: m[1]!.replace(/\/$/, '') };
        resolve(this.started);
      });
      child.once('error', (err) => fail(new Error(`termd: cannot start ${this.binary}: ${err.message}`)));
      child.once('exit', (code, signal) => {
        if (stderrTail) this.stderrRing.push(stderrTail);
        const message = `termd exited (${code === null ? `signal ${signal}` : `code ${code}`})${this.stderrSuffix()}`;
        if (!this.stopped) {
          this.dead ??= { message };
          if (settled) this.log(message);
        }
        this.started = undefined;
        fail(new Error(message));
      });
    });
  }

  private stderrSuffix(): string {
    return this.stderrRing.length ? `: ${this.stderrRing.join('\n')}` : '';
  }

  /** SIGTERM termd, SIGKILL after the grace period; every later call rejects. */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.dead ??= { message: 'relayterm host stopped' };
    if (!child) return;
    if (this.starting) await this.starting.catch(() => {});
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.started = undefined;
  }

  // ---------- HTTP client ----------

  /** The error every call rejects with once termd is gone (unexpected exit or `stop()`). */
  private deadError(): Error | undefined {
    return this.dead ? new Error(this.dead.message) : undefined;
  }

  private async request(method: string, route: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
    const gone = this.deadError();
    if (gone) throw gone;
    const { baseUrl } = await this.start();
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      // A reset connection usually means termd died: give its exit event a moment to land so the error says so.
      await Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, EXIT_SETTLE_MS))]);
      throw this.deadError() ?? new Error(`termd ${method} ${route} unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const died = this.deadError();
    if (died) throw died;
    return { status: res.status, json, text };
  }

  private unexpected(method: string, route: string, r: { status: number; json: unknown; text: string }): Error {
    const detail = (r.json as { error?: string } | undefined)?.error ?? r.text;
    return new Error(`termd ${method} ${route} failed (${r.status}): ${detail}`);
  }

  // ---------- TerminalHost ----------

  async spawn(opts: RelaytermSpawnOptions): Promise<{ paneId: string }> {
    const body: PostPanesBody = {
      name: opts.name, argv: opts.argv, cwd: opts.cwd, env: opts.env,
      ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
      ...(opts.taskId === undefined ? {} : { task_id: opts.taskId }),
      cols: opts.cols ?? DEFAULT_COLS, rows: opts.rows ?? DEFAULT_ROWS,
    };
    const r = await this.request('POST', '/panes', body);
    const json = r.json as { pane_id?: string; error?: string } | undefined;
    // Prompt delivery failed: the same message shape as the TS host, so the orchestrator's handling is unchanged.
    if (r.status === 502 && json?.error) throw new Error(json.error);
    if (r.status !== 201 || !json?.pane_id) throw this.unexpected('POST', '/panes', r);
    return { paneId: json.pane_id };
  }

  async focus(paneId: string): Promise<void> {
    const route = `/panes/${paneId}/focus`;
    const r = await this.request('POST', route);
    if (r.status === 404) throw new Error(`pane ${paneId} not found`);
    if (r.status !== 200) throw this.unexpected('POST', route, r);
  }

  async isAlive(paneId: string): Promise<boolean> {
    const route = `/panes/${paneId}`;
    const r = await this.request('GET', route);
    if (r.status === 404) return false;
    if (r.status !== 200) throw this.unexpected('GET', route, r);
    return (r.json as { alive?: boolean }).alive === true;
  }

  async kill(paneId: string): Promise<void> {
    const route = `/panes/${paneId}/kill`;
    const r = await this.request('POST', route);
    if (r.status === 404) throw new Error(`pane ${paneId} not found`);
    if (r.status !== 200) throw this.unexpected('POST', route, r);
  }

  /** Kills every alive pane through termd, then stops termd itself. */
  async killAll(): Promise<void> {
    if (this.starting && !this.dead) {
      const r = await this.request('GET', '/panes');
      if (r.status !== 200) throw this.unexpected('GET', '/panes', r);
      const panes = (r.json as { panes: Array<{ pane_id: string; alive: boolean }> }).panes;
      await Promise.all(panes.filter((p) => p.alive).map((p) => this.kill(p.pane_id)));
    }
    await this.stop();
  }
}

export function createRelaytermHost(deps: RelaytermHostDeps): RelaytermHost {
  return new RelaytermHost(deps);
}
