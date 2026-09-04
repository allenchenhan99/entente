/**
 * relayd entry point. Reads config from the environment, opens the JSONL run log, composes the
 * orchestrator over real ports where their modules have been merged (dynamic import, guarded)
 * and in-memory fakes otherwise, then serves HTTP + SSE + MCP on 127.0.0.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { routes } from '@relay/protocol';
import type { RuntimeKind } from '@relay/protocol';
import { loadConfig, runDir, RELAYD_VERSION } from './config.js';
import type { RelaydConfig } from './config.js';
import { createJsonlStore } from './store/jsonl-store.js';
import { createOrchestrator } from './orchestrator/orchestrator.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import { createApp } from './http/app.js';
import { mountPty } from './http/pty.js';
import { mountPtyProxy } from './http/pty-proxy.js';
import { createSessionAuth } from './auth/token.js';
import type { RelayHost } from './pty/host.js';
import type { RelaytermHost } from './launch/hosts/relayterm.js';
import { usingFallbackLint } from './lint.js';
import type { EventStore, WorktreeManager, CheckRunner, RepairPolicy, TerminalHost, AgentRuntime } from './ports.js';
import { fakeWorktrees, fakeChecks, fakeRepair, fakeHost, fakeRuntime } from './fakes/index.js';
import { createWorkspaceTracker, readWorkspace, panesFromEvents } from './persist/workspace.js';
import { resolveResumeEnv, hasRecordedEvents, restoreRun, nextRelayPaneNumber } from './persist/restore.js';

type Module = Record<string, unknown>;
export type Importer = (spec: string) => Promise<Module | undefined>;

export interface PortDeps {
  config: RelaydConfig;
  store: EventStore;
  repoRoot: string;
  relayDir: string;
  /** Resolved before the check runner, which needs it to collect diffs. */
  worktrees?: WorktreeManager;
  /** The daemon's environment; the check runner filters it through the sandbox allow-list. */
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

export interface Ports {
  worktrees: WorktreeManager;
  checks: CheckRunner;
  repair: RepairPolicy;
  host: TerminalHost;
  runtimes: Record<RuntimeKind, AgentRuntime>;
  /** Port names that fell back to in-memory fakes. */
  fakes: string[];
}

/** Sibling modules owned by other work packages; absent until merged. */
const MODULES = {
  worktree: './worktree/index.js',
  verify: './verify/index.js',
  repair: './repair/index.js',
  launch: './launch/index.js',
} as const;

/**
 * Factory export names we accept, in order of preference (see HANDOFF_NOTES.md).
 * `launch` exports `createTerminalHost(kind, deps)` / `createRuntime(kind, deps)`; the others are
 * expected to export `create*(deps)`.
 */
const FACTORIES = {
  worktrees: ['createWorktreeManager', 'gitWorktreeManager', 'worktreeManager'],
  checks: ['createCheckRunner', 'createVerifier', 'checkRunner'],
  repair: ['createRepairPolicy', 'repairPolicy'],
  host: ['createTerminalHost', 'terminalHost'],
  runtime: ['createRuntime', 'createAgentRuntime', 'agentRuntime'],
} as const;

const defaultImporter: Importer = async (spec) => {
  try {
    return (await import(spec)) as Module;
  } catch {
    return undefined;
  }
};

async function fromModule<T>(mod: Module | undefined, names: readonly string[], args: unknown[], log: (msg: string) => void): Promise<T | undefined> {
  if (!mod) return undefined;
  for (const name of names) {
    const candidate = mod[name];
    if (typeof candidate === 'function') {
      try {
        return (await (candidate as (...a: unknown[]) => T | Promise<T>)(...args)) as T;
      } catch (err) {
        log(`relayd: ${name}(${args.map((a) => (typeof a === 'string' ? a : '…')).join(', ')}) failed: ${(err as Error).message}; using fake`);
        return undefined;
      }
    }
  }
  return undefined;
}

export async function resolvePorts(
  config: RelaydConfig,
  store: EventStore,
  log: (msg: string) => void = () => {},
  importer: Importer = defaultImporter,
  env: Record<string, string | undefined> = process.env,
): Promise<Ports> {
  const deps: PortDeps = { config, store, repoRoot: config.repoRoot, relayDir: config.relayDir, env, log };
  const fakes: string[] = [];
  const [worktreeMod, verifyMod, repairMod, launchMod] = await Promise.all([
    importer(MODULES.worktree), importer(MODULES.verify), importer(MODULES.repair), importer(MODULES.launch),
  ]);
  const fake = <T>(name: string, make: () => T): T => {
    fakes.push(name);
    return make();
  };

  const worktrees = (await fromModule<WorktreeManager>(worktreeMod, FACTORIES.worktrees, [deps], log)) ?? fake('worktrees', fakeWorktrees);
  const checks = (await fromModule<CheckRunner>(verifyMod, FACTORIES.checks, [{ ...deps, worktrees }], log)) ?? fake('checks', () => fakeChecks({}, store));
  const repair = (await fromModule<RepairPolicy>(repairMod, FACTORIES.repair, [deps], log)) ?? fake('repair', fakeRepair);
  const useLaunch = config.host !== 'fake';
  // The relay and relayterm hosts record casts under the run directory, so they alone need config-derived deps.
  const hostDeps = config.host === 'relay' || config.host === 'relayterm' ? { relayDir: config.relayDir, runId: config.runId } : {};
  const host = (useLaunch ? await fromModule<TerminalHost>(launchMod, FACTORIES.host, [config.host, hostDeps], log) : undefined) ?? fake('host', fakeHost);
  const runtimes = {} as Record<RuntimeKind, AgentRuntime>;
  for (const kind of ['claude-code', 'codex'] as RuntimeKind[]) {
    const real = useLaunch ? await fromModule<AgentRuntime>(launchMod, FACTORIES.runtime, [kind, {}], log) : undefined;
    runtimes[kind] = real ?? fake(`runtime:${kind}`, () => fakeRuntime(kind));
  }
  if (fakes.length) log(`relayd: using in-memory fakes for ${fakes.join(', ')}`);
  if (usingFallbackLint) log('relayd: @relay/protocol has no lintContract yet; using fallback lint rules');
  return { worktrees, checks, repair, host, runtimes, fakes };
}

export interface RunningRelayd {
  server: ServerType;
  port: number;
  url: string;
  orchestrator: Orchestrator;
  close(): Promise<void>;
}

export async function main(env: Record<string, string | undefined> = process.env, log: (msg: string) => void = console.log): Promise<RunningRelayd> {
  // RELAY_RUN_ID=<existing run> or RELAY_RESUME=latest: reopen that run's log and bring its agents back.
  const config = loadConfig(resolveResumeEnv(env));
  fs.mkdirSync(config.relayDir, { recursive: true });
  const dir = runDir(config);
  const resuming = hasRecordedEvents(dir);
  const store = createJsonlStore({ dir, log: (m) => console.error(`relayd: ${m}`) });
  const ports = await resolvePorts(config, store, log, defaultImporter, env);
  // Per-daemon session token (docs/security.md): printed once, written to <relayDir>/session.token (0600).
  const auth = createSessionAuth({ relayDir: config.relayDir, mode: config.authMode });
  if (resuming && (ports.host.kind === 'relay' || ports.host.kind === 'relayterm')) {
    // The relay host numbers panes from 1 and casts are opened with `flags: 'w'`; without this the respawned
    // `relay:1` would overwrite the previous run's recording (see HANDOFF_NOTES.md for the proper host option).
    const known = [...(readWorkspace(dir)?.panes ?? []), ...panesFromEvents(store.all(), config.relayDir)];
    const host = ports.host as unknown as { next?: number };
    const next = nextRelayPaneNumber(known.map((p) => p.pane_id));
    if (typeof (host as { setNextPane?: (n: number) => void }).setNextPane === 'function') (host as { setNextPane: (n: number) => void }).setNextPane(next);
  }

  // Bind first so an ephemeral port (RELAY_PORT=0) is known before the orchestrator needs the MCP URL.
  let fetchImpl: ((req: Request) => Response | Promise<Response>) | undefined;
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: (req: Request) => fetchImpl!(req), port: config.port, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const url = `http://127.0.0.1:${port}`;

  const orchestrator = createOrchestrator({
    store, ...ports, repoRoot: config.repoRoot, relayDir: config.relayDir, mcpUrl: `${url}${routes.mcp}`,
    log: (m) => console.error(`relayd: ${m}`),
  });
  const app = createApp({ orchestrator, store, auth });
  // RELAY_HOST=relay: relayd hosts the agent terminals itself (PRD §23): pane routes + WebSocket upgrade.
  if (config.host === 'relay' && (ports.host.kind as string) === 'relay') {
    const { handleUpgrade } = mountPty(app, ports.host as unknown as RelayHost, { auth });
    server.on('upgrade', handleUpgrade);
  }
  // RELAY_HOST=relayterm: the Rust termd owns the terminals; relayd starts it now (so `--first-pane` from the
  // resume above is honoured) and proxies /panes*, /pty/* and /metrics to it (docs/relay-term-spec.md §10).
  let termd: RelaytermHost | undefined;
  if (config.host === 'relayterm' && ports.host.kind === 'relayterm') {
    termd = ports.host as unknown as RelaytermHost;
    const { baseUrl } = await termd.start();
    log(`relayd: termd listening on ${baseUrl} (pid ${termd.pid})`);
    const { handleUpgrade } = mountPtyProxy(app, { baseUrl, token: termd.token, auth });
    server.on('upgrade', handleUpgrade);
  }
  fetchImpl = (req) => app.fetch(req);

  log(`relayd ${RELAYD_VERSION} · repo ${config.repoRoot} · log ${path.join(dir, 'events.jsonl')}`);
  log(`relayd token: ${auth.token} (file ${auth.file}; RELAY_AUTH=${auth.mode})`);
  log(`relayd listening on ${url}`);

  // Pane inventory for the next restart; subscribed before restore so respawned panes are recorded.
  const tracker = createWorkspaceTracker({
    store, runDir: dir, runId: config.runId, repo: config.repoRoot, relayDir: config.relayDir, host: ports.host,
    log: (m) => console.error(`relayd: ${m}`),
  });
  if (resuming) {
    const r = await restoreRun({ store, orchestrator, runDir: dir, relayDir: config.relayDir, hostKind: config.host, log: (m) => log(`relayd: ${m}`) });
    const failed = r.failed.length ? `, ${r.failed.length} failed` : '';
    log(`relayd resumed run ${config.runId} (${r.tasks} tasks, ${r.respawned.length} panes respawned${failed})`);
  }

  const close = async () => {
    tracker.stop();
    // termd goes with the daemon (its panes get SIGHUP as the ptys close); casts are already on disk.
    if (termd) await termd.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { server, port, url, orchestrator, close };
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().then((running) => {
    const stop = () => { void running.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
