/**
 * The `relay` TerminalHost (PRD §23): relayd hosts agent terminals itself. One `Pane` per spawn, ids
 * `relay:<n>`, casts under `<relayDir>/runs/<run-id>/casts/`, prompt delivery driven by the screen model.
 *
 * `TerminalHost.kind` (frozen) does not list `relay`; see HANDOFF_NOTES.md. Structurally this class satisfies
 * every other member of the port and `launch/index.ts` casts at the boundary.
 */
import path from 'node:path';
import type { z } from 'zod';
import type { PaneInfo, PaneReadiness, ScreenSnapshot, PaneInputBody } from '@relay/protocol';
import type { WaitOutputResult as WaitOutputResultSchema } from '@relay/protocol';

export type WaitOutputResult = z.infer<typeof WaitOutputResultSchema>;
import type { SpawnOptions } from '../ports.js';
import { Pane, runtimeOf, KILL_GRACE_MS } from './pane.js';
import type { ScreenQuery } from './screen.js';
import { keysToBytes } from './keys.js';
import { QUIET_MS } from './readiness.js';

export interface PromptTimings {
  /** No output for this long = quiet (also the readiness window). */
  quietMs: number;
  /** Press Enter again if the last line has not changed this long after the prompt. */
  retryMs: number;
  /** Give up (throw, pane left open) after this long from spawn. */
  timeoutMs: number;
}

export const DEFAULT_PROMPT_TIMINGS: PromptTimings = { quietMs: QUIET_MS, retryMs: 5000, timeoutMs: 30_000 };

export interface RelayHostDeps {
  relayDir: string;
  runId: string;
  clock?: () => string;
  timings?: Partial<PromptTimings>;
  /** First pane number to hand out (daemon restart: one past the run's highest recorded `relay:<n>`). */
  firstPane?: number;
}

export interface RelaySpawnOptions extends SpawnOptions {
  cols?: number;
  rows?: number;
}

export interface WaitOutputOptions {
  match?: string;
  regex?: string;
  timeout_ms: number;
  source: 'visible' | 'recent';
}

export class PaneNotFoundError extends Error {
  constructor(readonly paneId: string) {
    super(`pane ${paneId} not found`);
  }
}

/** Rows of scrollback a `recent` wait-output scan looks at (the `ReadScreenQuery.lines` default). */
const WAIT_RECENT_LINES = 200;
const POLL_MS = 25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RelayHost {
  readonly kind = 'relay' as const;
  focusedPane: string | undefined;
  private readonly panes = new Map<string, Pane>();
  private next: number;
  private readonly castDir: string;
  private readonly clock: () => string;
  private readonly timings: PromptTimings;

  constructor(deps: RelayHostDeps) {
    this.next = deps.firstPane ?? 1;
    this.castDir = path.join(deps.relayDir, 'runs', deps.runId, 'casts');
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.timings = { ...DEFAULT_PROMPT_TIMINGS, ...deps.timings };
  }

  /** Daemon restart: continue numbering after the run's highest recorded pane so casts are never overwritten. */
  setNextPane(n: number): void {
    if (n > this.next) this.next = n;
  }

  get(paneId: string): Pane | undefined {
    return this.panes.get(paneId);
  }

  private require(paneId: string): Pane {
    const pane = this.panes.get(paneId);
    if (!pane) throw new PaneNotFoundError(paneId);
    return pane;
  }

  list(): PaneInfo[] {
    return [...this.panes.values()].map((p) => p.info());
  }

  // ---------- TerminalHost ----------

  async spawn(opts: RelaySpawnOptions): Promise<{ paneId: string }> {
    if (opts.argv.length === 0) throw new Error('relay host: argv must not be empty');
    const paneId = `relay:${this.next}`;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v;
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', RELAY_PANE_ID: paneId });
    const pane = new Pane({
      paneId, role: opts.name, runtime: runtimeOf(opts.argv), argv: opts.argv, cwd: opts.cwd, env,
      castPath: path.join(this.castDir, `${paneId}.cast`), cols: opts.cols, rows: opts.rows, clock: this.clock, quietMs: this.timings.quietMs,
    });
    this.next++;
    this.panes.set(paneId, pane);
    if (opts.prompt !== undefined) await this.deliverPrompt(pane, opts.prompt);
    return { paneId };
  }

  async focus(paneId: string): Promise<void> {
    this.require(paneId);
    this.focusedPane = paneId;
  }

  async isAlive(paneId: string): Promise<boolean> {
    return this.panes.get(paneId)?.alive ?? false;
  }

  /** SIGTERM, SIGKILL after `graceMs` (3 s); resolves once the process is gone. */
  async kill(paneId: string, graceMs = KILL_GRACE_MS): Promise<void> {
    await this.require(paneId).kill(graceMs);
  }

  async killAll(graceMs = KILL_GRACE_MS): Promise<void> {
    await Promise.all([...this.panes.values()].map((p) => p.kill(graceMs)));
  }

  // ---------- screen, readiness, input, wait-output ----------

  snapshot(paneId: string, query: ScreenQuery): ScreenSnapshot {
    return this.require(paneId).snapshot(query);
  }

  readiness(paneId: string): PaneReadiness | undefined {
    return this.panes.get(paneId)?.readiness();
  }

  /** `text` typed as-is (bracketed paste when enabled), then `keys`; an unknown key writes nothing (throws). */
  input(paneId: string, body: PaneInputBody): void {
    const pane = this.require(paneId);
    const keyBytes = body.keys ? keysToBytes(body.keys) : '';
    if (body.text) pane.paste(body.text);
    if (keyBytes) pane.write(keyBytes);
  }

  waitOutput(paneId: string, opts: WaitOutputOptions): Promise<WaitOutputResult> {
    const pane = this.require(paneId);
    if (opts.match === undefined && opts.regex === undefined) throw new Error('wait-output needs match or regex');
    const regex = opts.regex === undefined ? undefined : new RegExp(opts.regex);
    const matches = (line: string): boolean =>
      (opts.match !== undefined && line.includes(opts.match)) || (regex !== undefined && regex.test(line));
    const scan = (): WaitOutputResult | undefined => {
      const { lines } = pane.snapshot({ source: opts.source, lines: WAIT_RECENT_LINES });
      const line = lines.find(matches);
      return line === undefined ? undefined : { status: 'matched', line, at: this.clock() };
    };
    const now = scan();
    if (now) return Promise.resolve(now);
    if (!pane.alive) return Promise.resolve({ status: 'exited', code: pane.info().exit_code! });
    return new Promise<WaitOutputResult>((resolve) => {
      let done = false;
      const finish = (result: WaitOutputResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        offOutput();
        offExit();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: 'timeout' }), opts.timeout_ms);
      const offOutput = pane.onOutput(() => {
        const hit = scan();
        if (hit) finish(hit);
      });
      const offExit = pane.onExit((code) => finish(scan() ?? { status: 'exited', code }));
    });
  }

  // ---------- prompt delivery ----------

  private async deliverPrompt(pane: Pane, prompt: string): Promise<void> {
    const { quietMs, retryMs, timeoutMs } = this.timings;
    const deadline = Date.now() + timeoutMs;
    const fail = (why: string) => new Error(`agent prompt failed: ${why}; pane ${pane.id} left open for diagnosis`);
    const exitedWhy = () => `process exited with code ${pane.info().exit_code} before taking the prompt`;

    await Promise.race([pane.firstOutput, pane.exited, sleep(timeoutMs)]);
    // Ready = quiet for `quietMs` and the screen shows a prompt / composer line.
    for (;;) {
      if (!pane.alive) throw fail(exitedWhy());
      if (Date.now() > deadline) throw fail(`no prompt on screen within ${timeoutMs} ms (last line: ${JSON.stringify(pane.lastLine() ?? '')})`);
      if (pane.quietFor() >= quietMs && pane.readiness().ready) break;
      await sleep(POLL_MS);
    }
    const before = pane.lastLine();
    pane.paste(prompt);
    pane.write('\r');
    let lastEnterAt = Date.now();
    let retries = 0;
    const prefix = prompt.slice(0, 24);
    // The prompt is still sitting in the agent's composer when the screen shows a paste placeholder
    // (Codex: `› [Pasted Content 2981 chars]`) or a composer line that still starts with our text.
    const stillInComposer = () => pane.visibleLines().some((l) => /\[Pasted Content/.test(l) || ((/^[❯›>] /.test(l.trim()) || l.trim() === '›') && l.includes(prefix)));
    // Accepted = the agent is visibly busy, or the screen moved on and the composer is clear.
    const accepted = () => {
      const r = pane.readiness();
      if (!r.ready && r.detail?.startsWith('busy')) return true;
      return !stillInComposer() && pane.lastLine() !== before;
    };
    while (!accepted()) {
      if (!pane.alive) throw fail(exitedWhy());
      if (Date.now() > deadline) throw fail(`prompt not accepted within ${timeoutMs} ms (last line: ${JSON.stringify(pane.lastLine() ?? '')})`);
      if (stillInComposer() && retries < 3 && Date.now() - lastEnterAt >= retryMs) {
        pane.write('\r');
        lastEnterAt = Date.now();
        retries++;
      }
      await sleep(POLL_MS);
    }
  }
}

export function createRelayHost(deps: RelayHostDeps): RelayHost {
  return new RelayHost(deps);
}
