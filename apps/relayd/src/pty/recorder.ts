/**
 * asciinema v2 recorder for one pane: `<relayDir>/runs/<run-id>/casts/<pane>.cast`.
 * Header `{"version":2,"width","height","timestamp","title"}`, then `[t,"o",data]` per output chunk and
 * `[t,"r","<cols>x<rows>"]` on resize. Every event is written to a write stream immediately (no batching), so a
 * crash loses at most what the OS had not yet flushed.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CastRecorderOptions {
  path: string;
  cols: number;
  rows: number;
  title: string;
  /** Monotonic ms clock for event times; defaults to `performance.now`. */
  now?: () => number;
  /** Unix seconds for the header; defaults to the wall clock. */
  timestamp?: number;
}

export class CastRecorder {
  readonly path: string;
  private readonly stream: fs.WriteStream;
  private readonly now: () => number;
  private readonly startedAt: number;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: CastRecorderOptions) {
    this.path = opts.path;
    this.now = opts.now ?? (() => performance.now());
    this.startedAt = this.now();
    fs.mkdirSync(path.dirname(opts.path), { recursive: true });
    this.stream = fs.createWriteStream(opts.path, { flags: 'w' });
    const header = { version: 2, width: opts.cols, height: opts.rows, timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000), title: opts.title };
    this.line(JSON.stringify(header));
  }

  private elapsed(): number {
    return Math.round((this.now() - this.startedAt)) / 1000;
  }

  private line(text: string): void {
    if (this.closed) return;
    const done = new Promise<void>((resolve) => this.stream.write(text + '\n', () => resolve()));
    this.pending = this.pending.then(() => done);
  }

  output(data: string): void {
    this.line(JSON.stringify([this.elapsed(), 'o', data]));
  }

  resize(cols: number, rows: number): void {
    this.line(JSON.stringify([this.elapsed(), 'r', `${cols}x${rows}`]));
  }

  /** Resolves once everything written so far has been handed to the OS. */
  flushed(): Promise<void> {
    return this.pending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.pending;
    this.closed = true;
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
  }
}
