/**
 * One relay pane: a `node-pty` process, a headless xterm screen of the same size, a raw byte ring (the scrollback
 * new WebSocket clients replay) and an asciinema recorder. Every output chunk goes to all of them and to every
 * `onOutput` subscriber (WebSocket clients, wait-output pollers, the prompt deliverer).
 */
import path from 'node:path';
import * as nodePty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { PaneInfo, PaneReadiness, ScreenSnapshot } from '@relay/protocol';
import { CastRecorder } from './recorder.js';
import { readScreen, type ScreenQuery } from './screen.js';
import { evaluateReadiness, lastNonEmptyLine, QUIET_MS } from './readiness.js';

// @xterm/headless ships a UMD bundle: under NodeNext it is a default export carrying `Terminal`.
const { Terminal } = xtermHeadless as unknown as typeof import('@xterm/headless');

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;
/** Raw bytes retained per pane for late-joining clients. */
export const RING_CAPACITY = 256 * 1024;
/** Rows the headless terminal keeps above the viewport (`recent` reads at most `ReadScreenQuery.lines` ≤ 5000). */
const HEADLESS_SCROLLBACK = 5000;
/** SIGTERM → SIGKILL grace. */
export const KILL_GRACE_MS = 3000;

export interface PaneOptions {
  paneId: string;
  role: string;
  runtime?: PaneInfo['runtime'];
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  castPath: string;
  cols?: number;
  rows?: number;
  /** ISO clock for PaneInfo timestamps. */
  clock?: () => string;
  quietMs?: number;
}

/** Bounded FIFO of raw output bytes. */
class ByteRing {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly capacity: number) {}
  push(chunk: Buffer): void {
    if (chunk.length >= this.capacity) {
      this.chunks = [chunk.subarray(chunk.length - this.capacity)];
      this.size = this.capacity;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.capacity) {
      const excess = this.size - this.capacity;
      const head = this.chunks[0]!;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class Pane {
  readonly id: string;
  readonly role: string;
  readonly runtime: PaneInfo['runtime'];
  readonly cwd: string;
  readonly castPath: string;
  readonly recorder: CastRecorder;
  readonly term: HeadlessTerminal;
  /** Resolves with the exit code once the process has ended. */
  readonly exited: Promise<number>;
  readonly startedAt: string;

  private readonly pty: nodePty.IPty;
  private readonly ring = new ByteRing(RING_CAPACITY);
  private readonly outputListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  private readonly clock: () => string;
  private readonly quietMs: number;
  private firstOutputResolve!: () => void;
  /** Resolves on the first output byte. */
  readonly firstOutput: Promise<void>;
  private cols: number;
  private rows: number;
  private exitCode: number | undefined;
  private exitedAt: string | undefined;
  private lastOutputAt: number | undefined;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(opts: PaneOptions) {
    this.id = opts.paneId;
    this.role = opts.role;
    this.runtime = opts.runtime;
    this.cwd = opts.cwd;
    this.castPath = opts.castPath;
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.quietMs = opts.quietMs ?? QUIET_MS;
    this.cols = opts.cols ?? DEFAULT_COLS;
    this.rows = opts.rows ?? DEFAULT_ROWS;
    this.startedAt = this.clock();
    this.firstOutput = new Promise<void>((resolve) => { this.firstOutputResolve = resolve; });

    const [file, ...args] = opts.argv;
    if (!file) throw new Error('relay host: argv must not be empty');
    this.term = new Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true, scrollback: HEADLESS_SCROLLBACK });
    this.recorder = new CastRecorder({ path: opts.castPath, cols: this.cols, rows: this.rows, title: opts.role });
    this.pty = nodePty.spawn(file, args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: opts.cwd, env: opts.env });

    this.exited = new Promise<number>((resolve) => {
      this.pty.onExit(({ exitCode }) => {
        this.exitCode = exitCode;
        this.exitedAt = this.clock();
        if (this.killTimer) clearTimeout(this.killTimer);
        void this.recorder.close();
        for (const l of this.exitListeners) l(exitCode);
        resolve(exitCode);
      });
    });
    this.pty.onData((data) => this.handleOutput(data));
  }

  private handleOutput(data: string): void {
    this.lastOutputAt = Date.now();
    const bytes = Buffer.from(data, 'utf8');
    this.ring.push(bytes);
    this.term.write(data);
    this.recorder.output(data);
    this.firstOutputResolve();
    for (const l of this.outputListeners) l(bytes);
  }

  get pid(): number {
    return this.pty.pid;
  }

  get alive(): boolean {
    return this.exitCode === undefined;
  }

  info(): PaneInfo {
    return {
      pane_id: this.id,
      role: this.role,
      runtime: this.runtime,
      cwd: this.cwd,
      pid: this.pid,
      alive: this.alive,
      cols: this.cols,
      rows: this.rows,
      cast_path: this.castPath,
      started_at: this.startedAt,
      exited_at: this.exitedAt,
      exit_code: this.exitCode,
    };
  }

  /** Raw bytes retained for late clients (≤ 256 KiB). */
  scrollback(): Buffer {
    return this.ring.bytes();
  }

  snapshot(query: ScreenQuery): ScreenSnapshot {
    return readScreen(this.term, this.id, query);
  }

  /** The last non-empty visible line (what prompt delivery watches). */
  lastLine(): string | undefined {
    return lastNonEmptyLine(this.snapshot({ source: 'visible', lines: 0 }).lines);
  }

  readiness(now = Date.now()): PaneReadiness {
    return evaluateReadiness({
      paneId: this.id, lines: this.snapshot({ source: 'visible', lines: 0 }).lines, lastOutputAt: this.lastOutputAt,
      now, quietMs: this.quietMs, exited: !this.alive, observedAt: this.clock(),
    });
  }

  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  /** ms since the last output byte (Infinity before the first). */
  quietFor(now = Date.now()): number {
    return this.lastOutputAt === undefined ? Infinity : now - this.lastOutputAt;
  }

  write(data: string | Buffer): void {
    if (!this.alive) return;
    this.pty.write(typeof data === 'string' ? data : data.toString('binary'));
  }

  /** Types `text` the way a paste would: wrapped in bracketed-paste markers when the program asked for them. */
  paste(text: string): void {
    this.write(this.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.alive) this.pty.resize(cols, rows);
    this.term.resize(cols, rows);
    this.recorder.resize(cols, rows);
  }

  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (code: number) => void): () => void {
    if (!this.alive) {
      listener(this.exitCode!);
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** SIGTERM, then SIGKILL after `graceMs`; resolves once the process has exited. */
  async kill(graceMs = KILL_GRACE_MS): Promise<void> {
    if (!this.alive) return;
    this.pty.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (this.alive) this.pty.kill('SIGKILL');
    }, graceMs);
    await this.exited;
  }
}

/** `claude` / `claude-code` → claude-code, `codex` → codex, anything else → undefined. */
export function runtimeOf(argv: string[]): PaneInfo['runtime'] {
  const base = argv[0] ? path.basename(argv[0]) : '';
  if (base === 'claude' || base === 'claude-code') return 'claude-code';
  if (base === 'codex') return 'codex';
  return undefined;
}
