/** Seekable asciinema v2 replay backed by a fresh headless xterm screen. */
import fs from 'node:fs';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { ScreenSnapshot } from '@relay/protocol';
import { readScreen } from './screen.js';

// @xterm/headless ships a UMD bundle: under NodeNext it is a default export carrying `Terminal`.
const { Terminal } = xtermHeadless as unknown as typeof import('@xterm/headless');

export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
  [key: string]: unknown;
}

export interface CastInfo {
  header: CastHeader;
  duration: number;
  events: number;
}

export interface ScreenAtOptions {
  /** Pane id placed in the snapshot; defaults to the cast filename or `relay:replay`. */
  paneId?: string;
}

type CastEvent = readonly [time: number, type: 'o' | 'r', data: string];
interface ParsedCast {
  header: CastHeader;
  events: CastEvent[];
  duration: number;
}

interface CacheEntry {
  mtimeMs: number;
  parsed: ParsedCast;
}

const parsedCasts = new Map<string, CacheEntry>();
const PANE_ID = /^relay:[0-9a-z-]+$/;
const RESIZE = /^(\d+)x(\d+)$/;
const HEADLESS_SCROLLBACK = 5_000;

function parseHeader(value: unknown, castPath: string): CastHeader {
  if (typeof value !== 'object' || value === null) throw new Error(`${castPath}:1: invalid asciinema header`);
  const header = value as Record<string, unknown>;
  if (header.version !== 2 || !Number.isInteger(header.width) || Number(header.width) <= 0
    || !Number.isInteger(header.height) || Number(header.height) <= 0) {
    throw new Error(`${castPath}:1: expected an asciinema v2 header with positive width and height`);
  }
  return header as unknown as CastHeader;
}

function parseEvent(value: unknown, castPath: string, lineNumber: number): CastEvent | undefined {
  if (!Array.isArray(value) || value.length < 3) throw new Error(`${castPath}:${lineNumber}: invalid cast event`);
  const [time, type, data] = value;
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || typeof type !== 'string' || typeof data !== 'string') {
    throw new Error(`${castPath}:${lineNumber}: invalid cast event`);
  }
  // asciinema extensions such as input and markers do not affect the terminal screen.
  if (type !== 'o' && type !== 'r') return undefined;
  if (type === 'r') {
    const match = RESIZE.exec(data);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
      throw new Error(`${castPath}:${lineNumber}: invalid resize event`);
    }
  }
  return [time, type, data];
}

function parseCast(castPath: string): ParsedCast {
  const resolved = path.resolve(castPath);
  const mtimeMs = fs.statSync(resolved).mtimeMs;
  const cached = parsedCasts.get(resolved);
  if (cached?.mtimeMs === mtimeMs) return cached.parsed;

  const text = fs.readFileSync(resolved, 'utf8');
  const lines = text.split('\n');
  const headerLine = lines[0];
  if (!headerLine?.trim()) throw new Error(`${resolved}: missing asciinema header`);

  let headerValue: unknown;
  try {
    headerValue = JSON.parse(headerLine);
  } catch {
    throw new Error(`${resolved}:1: invalid JSON`);
  }
  const header = parseHeader(headerValue, resolved);
  const events: CastEvent[] = [];
  let duration = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      const isTrailingPartialLine = index === lines.length - 1 && !text.endsWith('\n');
      if (isTrailingPartialLine) break;
      throw new Error(`${resolved}:${index + 1}: invalid JSON`);
    }
    const event = parseEvent(value, resolved, index + 1);
    if (!event) continue;
    events.push(event);
    duration = Math.max(duration, event[0]);
  }

  const parsed = { header, events, duration };
  parsedCasts.set(resolved, { mtimeMs, parsed });
  return parsed;
}

function paneIdFor(castPath: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const filename = path.basename(castPath, path.extname(castPath));
  return PANE_ID.test(filename) ? filename : 'relay:replay';
}

function write(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

export function castDuration(castPath: string): number {
  return parseCast(castPath).duration;
}

export function castInfo(castPath: string): CastInfo {
  const parsed = parseCast(castPath);
  return { header: { ...parsed.header }, duration: parsed.duration, events: parsed.events.length };
}

export async function screenAt(castPath: string, tSeconds: number, opts: ScreenAtOptions = {}): Promise<ScreenSnapshot> {
  if (!Number.isFinite(tSeconds) || tSeconds < 0) throw new RangeError('tSeconds must be a non-negative number');
  const parsed = parseCast(castPath);
  const term = new Terminal({
    cols: parsed.header.width,
    rows: parsed.header.height,
    allowProposedApi: true,
    scrollback: HEADLESS_SCROLLBACK,
  });

  try {
    let output = '';
    const flush = async () => {
      if (!output) return;
      const data = output;
      output = '';
      await write(term, data);
    };
    for (const event of parsed.events) {
      if (event[0] > tSeconds) continue;
      if (event[1] === 'o') {
        output += event[2];
        continue;
      }
      await flush();
      const match = RESIZE.exec(event[2])!;
      term.resize(Number(match[1]), Number(match[2]));
    }
    await flush();
    return readScreen(term, paneIdFor(castPath, opts.paneId), { source: 'visible', lines: 0 });
  } finally {
    term.dispose();
  }
}
