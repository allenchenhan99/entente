import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT, routes } from '@relay/protocol';

export type LauncherCommand = 'up' | 'status' | 'down';
export type LauncherHost = 'relay' | 'relayterm';
/** Which client takes over the terminal: the Rust `relay-tui` (crates/relay-tui) or the Ink TUI (apps/tui). */
export type LauncherTui = 'rust' | 'ink';

export interface LauncherOptions {
  command: LauncherCommand;
  repo: string;
  relayDir: string;
  relayDirExplicit?: true;
  port: number;
  /** Undefined = auto: `relayterm` when a `termd` binary is found, else the TypeScript `relay` host. */
  host?: LauncherHost;
  /** Undefined = auto: `rust` when a `relay-tui` binary is found (or `--replay` names a fixture directory), else `ink`. */
  tui?: LauncherTui;
  replay?: string;
  noSpawn: boolean;
}

export type ParsedArgs = LauncherOptions | { command: 'help' };

interface RawArgs {
  values: {
    repo?: string;
    port?: string;
    host?: string;
    tui?: string;
    dir?: string;
    replay?: string;
    'no-spawn'?: boolean;
    help?: boolean;
  };
  positionals: string[];
}

export class UsageError extends Error {}
export class LauncherError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
  }
}

export interface ChildProcessLike {
  pid?: number;
  unref(): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;

export interface FileSystem {
  existsSync(file: string): boolean;
  mkdirSync(directory: string, options: { recursive: true }): unknown;
  openSync(file: string, flags: string): number;
  closeSync(fd: number): void;
  writeFileSync(file: string, data: string, options?: { mode?: number }): void;
  readFileSync(file: string, encoding: 'utf8'): string;
  unlinkSync(file: string): void;
}

export interface SignalController {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
}

export interface LauncherDependencies {
  cwd: string;
  workspaceRoot: string;
  fetch: typeof globalThis.fetch;
  spawn: SpawnFunction;
  fs: FileSystem;
  env: Record<string, string | undefined>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  signals: SignalController;
  processKill: (pid: number, signal: NodeJS.Signals | 0) => boolean;
}

export interface HealthResult {
  healthy: boolean;
  responded: boolean;
  version?: string;
}

export const USAGE = `usage:
  entente [up] [--repo <path>] [--port N] [--host relay|relayterm] [--tui rust|ink] [--dir <relayDir>] [--replay <file|dir>] [--no-spawn]
  entente status [--repo <path>] [--port N] [--dir <relayDir>]
  entente down [--repo <path>] [--port N] [--dir <relayDir>]

--host defaults to relayterm when a termd binary is found (RELAY_TERMD, target/release, target/debug), else relay.
--tui defaults to rust when a relay-tui binary is found (RELAY_TUI, target/release, target/debug), else ink.`;

const HOSTS: readonly LauncherHost[] = ['relay', 'relayterm'];
const TUIS: readonly LauncherTui[] = ['rust', 'ink'];
const HEALTH_TIMEOUT_MS = 1_000;
const HEALTH_POLL_MS = 200;
const HEALTH_DEADLINE_MS = 15_000;
const TOKEN_DEADLINE_MS = 2_000;
const TOKEN_POLL_MS = 50;
const DEFAULT_WORKSPACE_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function portNumber(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(`--port must be an integer from 1 to 65535, got ${value}`);
  }
  return port;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): ParsedArgs {
  let parsed: RawArgs;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        tui: { type: 'string' },
        dir: { type: 'string' },
        replay: { type: 'string' },
        'no-spawn': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }) as RawArgs;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (parsed.values.help) return { command: 'help' };

  const positionals = [...parsed.positionals];
  const first = positionals.shift();
  let command: LauncherCommand;
  if (first === undefined || first === 'up') command = 'up';
  else if (first === 'status' || first === 'down') command = first;
  else if (first === 'help') return { command: 'help' };
  else throw new UsageError(`unknown command: ${first}`);
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);

  const host = parsed.values.host;
  if (host !== undefined && !HOSTS.includes(host as LauncherHost)) {
    throw new UsageError(`--host must be one of ${HOSTS.join('|')}, got ${host}`);
  }
  const tui = parsed.values.tui;
  if (tui !== undefined && !TUIS.includes(tui as LauncherTui)) {
    throw new UsageError(`--tui must be one of ${TUIS.join('|')}, got ${tui}`);
  }
  const repo = path.resolve(cwd, parsed.values.repo ?? '.');
  const explicitDir = parsed.values.dir === undefined ? undefined : path.resolve(cwd, parsed.values.dir);

  return {
    command,
    repo,
    relayDir: explicitDir ?? path.join(repo, '.relay'),
    ...(explicitDir === undefined ? {} : { relayDirExplicit: true as const }),
    port: portNumber(parsed.values.port),
    ...(host === undefined ? {} : { host: host as LauncherHost }),
    ...(tui === undefined ? {} : { tui: tui as LauncherTui }),
    ...(parsed.values.replay === undefined ? {} : { replay: parsed.values.replay }),
    noSpawn: parsed.values['no-spawn'] ?? false,
  };
}

function dependencies(overrides: Partial<LauncherDependencies>): LauncherDependencies {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    workspaceRoot: overrides.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    fetch: overrides.fetch ?? globalThis.fetch,
    spawn: overrides.spawn ?? (nodeSpawn as SpawnFunction),
    fs: overrides.fs ?? (fs as unknown as FileSystem),
    env: overrides.env ?? process.env,
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    stdout: overrides.stdout ?? ((line) => process.stdout.write(`${line}\n`)),
    stderr: overrides.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
    signals: overrides.signals ?? {
      on: (signal, listener) => { process.on(signal, listener); },
      off: (signal, listener) => { process.off(signal, listener); },
    },
    processKill: overrides.processKill ?? ((pid, signal) => process.kill(pid, signal)),
  };
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function checkHealth(
  url: string,
  deps: Pick<LauncherDependencies, 'fetch'>,
): Promise<HealthResult> {
  let response: Response;
  try {
    response = await deps.fetch(`${url}${routes.health}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch {
    return { healthy: false, responded: false };
  }
  if (!response.ok) return { healthy: false, responded: true };
  try {
    const value = await response.json() as { ok?: unknown; version?: unknown };
    if (value.ok === true && typeof value.version === 'string') {
      return { healthy: true, responded: true, version: value.version };
    }
  } catch {
    // A listener answered, but it did not provide relayd's health document.
  }
  return { healthy: false, responded: true };
}

export async function waitForHealth(
  url: string,
  deps: Pick<LauncherDependencies, 'fetch' | 'now' | 'sleep'>,
  timeoutMs: number = HEALTH_DEADLINE_MS,
): Promise<HealthResult> {
  const deadline = deps.now() + timeoutMs;
  while (true) {
    const result = await checkHealth(url, deps);
    if (result.healthy) return result;
    if (deps.now() >= deadline) throw new LauncherError(`relayd did not become healthy within ${timeoutMs / 1_000} seconds`);
    await deps.sleep(HEALTH_POLL_MS);
  }
}

/**
 * A Rust binary from the Relay Terminal rewrite: `RELAY_TERMD` / `RELAY_TUI` override, else the cargo output of this
 * checkout (`target/release`, then `target/debug`). Undefined when nothing is built, so the TypeScript fallback runs.
 */
export function findBinary(
  name: 'termd' | 'relay-tui',
  deps: Pick<LauncherDependencies, 'fs' | 'env' | 'workspaceRoot'>,
): string | undefined {
  const override = deps.env[name === 'termd' ? 'RELAY_TERMD' : 'RELAY_TUI'];
  if (override) return override;
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(deps.workspaceRoot, 'target', profile, name);
    if (deps.fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function executableArgs(workspaceRoot: string, app: 'relayd' | 'tui', fileSystem: Pick<FileSystem, 'existsSync'>): string[] {
  const dist = path.join(workspaceRoot, `apps/${app}/dist/index.js`);
  if (fileSystem.existsSync(dist)) return [dist];
  const source = path.join(workspaceRoot, `apps/${app}/src/index.${app === 'tui' ? 'tsx' : 'ts'}`);
  return ['--import', 'tsx', source];
}

export interface SpawnRelaydOptions extends Omit<LauncherOptions, 'host'> {
  workspaceRoot: string;
  host: LauncherHost;
  /** Path of the termd binary for `RELAY_HOST=relayterm` (exported as RELAY_TERMD). */
  termd?: string;
}

export function spawnRelayd(
  options: SpawnRelaydOptions,
  deps: Pick<LauncherDependencies, 'spawn' | 'fs' | 'env'>,
): ChildProcessLike {
  deps.fs.mkdirSync(options.relayDir, { recursive: true });
  const logPath = path.join(options.relayDir, 'relayd.log');
  const log = deps.fs.openSync(logPath, 'a');
  let child: ChildProcessLike;
  try {
    child = deps.spawn(process.execPath, executableArgs(options.workspaceRoot, 'relayd', deps.fs), {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...deps.env,
        RELAY_REPO: options.repo,
        ...(options.relayDirExplicit ? { RELAY_DIR: options.relayDir } : {}),
        RELAY_PORT: String(options.port),
        RELAY_HOST: options.host,
        ...(options.termd === undefined ? {} : { RELAY_TERMD: options.termd }),
        // `auto`, not `latest`: the first run of a repo has nothing recorded, and that is not an error.
        RELAY_RESUME: 'auto',
      },
    });
  } finally {
    deps.fs.closeSync(log);
  }
  if (child.pid === undefined) throw new LauncherError('relayd did not report a process id');
  child.unref();
  deps.fs.writeFileSync(path.join(options.relayDir, 'relayd.pid'), `${child.pid}\n`);
  return child;
}

export async function readToken(
  relayDir: string,
  deps: Pick<LauncherDependencies, 'fs' | 'now' | 'sleep'>,
  timeoutMs: number = TOKEN_DEADLINE_MS,
): Promise<string> {
  const file = path.join(relayDir, 'session.token');
  const deadline = deps.now() + timeoutMs;
  while (true) {
    try {
      const token = deps.fs.readFileSync(file, 'utf8').trim();
      if (token) return token;
    } catch {
      // relayd creates the token during boot; retry until the short deadline.
    }
    if (deps.now() >= deadline) throw new LauncherError(`session token was not written to ${file}`);
    await deps.sleep(TOKEN_POLL_MS);
  }
}

function lastLogLines(fileSystem: Pick<FileSystem, 'readFileSync'>, relayDir: string): string[] {
  try {
    const log = fileSystem.readFileSync(path.join(relayDir, 'relayd.log'), 'utf8').trimEnd();
    return log ? log.split('\n').slice(-20) : [];
  } catch {
    return [];
  }
}

export interface RunTuiOptions {
  workspaceRoot: string;
  tui: LauncherTui;
  /** The relay-tui binary (required when `tui` is `rust`). */
  binary?: string;
  /** Repo root passed to relay-tui so it can find `.relay/session.token` on reconnect. */
  repo?: string;
  url?: string;
  token?: string;
  replay?: string;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

export function runTui(
  options: RunTuiOptions,
  deps: Pick<LauncherDependencies, 'spawn' | 'fs' | 'signals'>,
): Promise<number> {
  let command = process.execPath;
  let args: string[];
  if (options.tui === 'rust') {
    if (options.binary === undefined) throw new LauncherError('--tui rust needs a relay-tui binary (cargo build -p relay-tui, or RELAY_TUI=<path>)');
    command = options.binary;
    args = [];
  } else {
    args = executableArgs(options.workspaceRoot, 'tui', deps.fs);
  }
  if (options.replay !== undefined) args.push('--replay', options.replay);
  else {
    if (options.url === undefined || options.token === undefined) throw new LauncherError('live TUI needs a relayd URL and session token');
    args.push('--url', options.url, '--token', options.token);
    if (options.tui === 'rust' && options.repo !== undefined) args.push('--repo', options.repo);
  }
  const child = deps.spawn(command, args, { detached: false, stdio: 'inherit' });

  return new Promise<number>((resolve, reject) => {
    const forwardInt = () => { child.kill('SIGINT'); };
    const forwardTerm = () => { child.kill('SIGTERM'); };
    const cleanup = () => {
      deps.signals.off('SIGINT', forwardInt);
      deps.signals.off('SIGTERM', forwardTerm);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new LauncherError(`could not start the TUI: ${error.message}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve(code ?? signalExitCode(signal));
    };
    deps.signals.on('SIGINT', forwardInt);
    deps.signals.on('SIGTERM', forwardTerm);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

/** `--replay` names a relay-tui fixture directory (dumped by scripts/dump-graph-fixture.mjs) or an Ink event log. */
function isFixtureDirectory(replay: string, fileSystem: Pick<FileSystem, 'existsSync'>): boolean {
  return fileSystem.existsSync(path.join(replay, 'graph.json'));
}

export interface ResolvedTerminalBase {
  host: LauncherHost;
  termd?: string;
  tui: LauncherTui;
  tuiBinary?: string;
}

/** Applies the `--host` / `--tui` defaults: our own terminal base (termd + relay-tui) whenever it is built. */
export function resolveTerminalBase(
  options: Pick<LauncherOptions, 'host' | 'tui' | 'replay'>,
  deps: Pick<LauncherDependencies, 'fs' | 'env' | 'workspaceRoot'>,
): ResolvedTerminalBase {
  const termd = findBinary('termd', deps);
  const tuiBinary = findBinary('relay-tui', deps);
  const host = options.host ?? (termd !== undefined ? 'relayterm' : 'relay');
  const tui = options.tui ?? (
    options.replay !== undefined ? (isFixtureDirectory(options.replay, deps.fs) ? 'rust' : 'ink')
      : tuiBinary !== undefined ? 'rust' : 'ink');
  return { host, ...(termd === undefined ? {} : { termd }), tui, ...(tuiBinary === undefined ? {} : { tuiBinary }) };
}

async function up(options: LauncherOptions, deps: LauncherDependencies): Promise<number> {
  const base = resolveTerminalBase(options, deps);
  if (options.replay !== undefined) {
    return runTui({ workspaceRoot: deps.workspaceRoot, tui: base.tui, binary: base.tuiBinary, replay: options.replay }, deps);
  }

  const url = baseUrl(options.port);
  const initialHealth = await checkHealth(url, deps);
  if (!initialHealth.healthy) {
    if (initialHealth.responded) throw new LauncherError(`port ${options.port} is busy, but the responder is not relayd`);
    if (options.noSpawn) throw new LauncherError('relayd is not running; remove --no-spawn to start it');
    spawnRelayd({ ...options, host: base.host, termd: base.termd, workspaceRoot: deps.workspaceRoot }, deps);
    try {
      await waitForHealth(url, deps);
    } catch (error) {
      throw new LauncherError(
        error instanceof Error ? error.message : String(error),
        lastLogLines(deps.fs, options.relayDir),
      );
    }
  }
  const token = await readToken(options.relayDir, deps);
  return runTui({ workspaceRoot: deps.workspaceRoot, tui: base.tui, binary: base.tuiBinary, repo: options.repo, url, token }, deps);
}

export async function status(options: LauncherOptions, deps: LauncherDependencies): Promise<number> {
  const health = await checkHealth(baseUrl(options.port), deps);
  const pid = readPid(options.relayDir, deps.fs);
  deps.stdout(
    `relayd ${health.healthy ? 'healthy' : 'down'} version ${health.version ?? '-'} `
    + `pid ${pid ?? '-'} relayDir ${options.relayDir}`,
  );
  return health.healthy ? 0 : 1;
}

function readPid(relayDir: string, fileSystem: Pick<FileSystem, 'readFileSync'>): number | undefined {
  const file = path.join(relayDir, 'relayd.pid');
  let text: string;
  try {
    text = fileSystem.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
  const pid = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid < 1) {
    throw new LauncherError(`invalid pid file ${file}`);
  }
  return pid;
}

function processIsAlive(pid: number, processKill: LauncherDependencies['processKill']): boolean {
  try {
    return processKill(pid, 0) !== false;
  } catch {
    return false;
  }
}

function removePid(relayDir: string, fileSystem: Pick<FileSystem, 'existsSync' | 'unlinkSync'>): void {
  const file = path.join(relayDir, 'relayd.pid');
  if (fileSystem.existsSync(file)) fileSystem.unlinkSync(file);
}

export async function down(options: LauncherOptions, deps: LauncherDependencies): Promise<number> {
  const pid = readPid(options.relayDir, deps.fs);
  if (pid === undefined) throw new LauncherError(`relayd pid file not found at ${path.join(options.relayDir, 'relayd.pid')}`);

  const alive = processIsAlive(pid, deps.processKill);
  const health = await checkHealth(baseUrl(options.port), deps);
  if (!alive) {
    removePid(options.relayDir, deps.fs);
    throw new LauncherError(`refusing to signal stale pid ${pid}`);
  }
  if (!health.healthy) {
    removePid(options.relayDir, deps.fs);
    throw new LauncherError(`refusing to signal pid ${pid} because relayd does not answer on port ${options.port}`);
  }

  deps.processKill(pid, 'SIGTERM');
  const deadline = deps.now() + 5_000;
  while (processIsAlive(pid, deps.processKill)) {
    if (deps.now() >= deadline) {
      removePid(options.relayDir, deps.fs);
      throw new LauncherError(`pid ${pid} did not exit within 5 seconds`);
    }
    await deps.sleep(Math.min(100, deadline - deps.now()));
  }
  removePid(options.relayDir, deps.fs);
  deps.stdout(`relayd stopped pid ${pid}`);
  return 0;
}

export async function runLauncher(
  argv: string[],
  overrides: Partial<LauncherDependencies> = {},
): Promise<number> {
  const deps = dependencies(overrides);
  try {
    const options = parseArgs(argv, deps.cwd);
    if (options.command === 'help') {
      deps.stdout(USAGE);
      return 0;
    }
    if (options.command === 'up') return await up(options, deps);
    if (options.command === 'status') return await status(options, deps);
    return await down(options, deps);
  } catch (error) {
    deps.stderr(`entente: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof LauncherError) {
      for (const line of error.details) deps.stderr(line);
    }
    return 1;
  }
}
