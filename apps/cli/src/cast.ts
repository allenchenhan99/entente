/** Local asciinema v2 parsing, headless screen rendering, and timed playback for the CLI. */
import fs from 'node:fs';
import xtermHeadless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = xtermHeadless as unknown as typeof import('@xterm/headless');

export interface CliCastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
  [key: string]: unknown;
}

export type CliCastEvent = readonly [time: number, type: 'o' | 'r', data: string];

export interface CliCast {
  header: CliCastHeader;
  events: CliCastEvent[];
  duration: number;
}

const RESIZE = /^(\d+)x(\d+)$/;

function validHeader(value: unknown): value is CliCastHeader {
  if (typeof value !== 'object' || value === null) return false;
  const header = value as Record<string, unknown>;
  return header.version === 2
    && Number.isInteger(header.width) && Number(header.width) > 0
    && Number.isInteger(header.height) && Number(header.height) > 0;
}

function castEvent(value: unknown, file: string, lineNumber: number): CliCastEvent | undefined {
  if (!Array.isArray(value) || value.length < 3) throw new Error(`${file}:${lineNumber}: invalid cast event`);
  const [time, type, data] = value;
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || typeof type !== 'string' || typeof data !== 'string') {
    throw new Error(`${file}:${lineNumber}: invalid cast event`);
  }
  if (type !== 'o' && type !== 'r') return undefined;
  if (type === 'r' && !RESIZE.test(data)) throw new Error(`${file}:${lineNumber}: invalid resize event`);
  return [time, type, data];
}

export function parseCastFile(file: string): CliCast {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = text.split('\n');
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(lines[0] ?? '');
  } catch {
    throw new Error(`${file}:1: invalid JSON header`);
  }
  if (!validHeader(headerValue)) throw new Error(`${file}:1: invalid asciinema v2 header`);

  const events: CliCastEvent[] = [];
  let duration = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 && !text.endsWith('\n')) break;
      throw new Error(`${file}:${index + 1}: invalid JSON`);
    }
    const event = castEvent(value, file, index + 1);
    if (!event) continue;
    events.push(event);
    duration = Math.max(duration, event[0]);
  }
  return { header: headerValue, events, duration };
}

function writeTerminal(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

export async function renderCastScreen(cast: CliCast, time: number): Promise<string[]> {
  const term = new Terminal({ cols: cast.header.width, rows: cast.header.height, scrollback: 5_000, allowProposedApi: true });
  try {
    let output = '';
    const flush = async () => {
      if (!output) return;
      const data = output;
      output = '';
      await writeTerminal(term, data);
    };
    for (const event of cast.events) {
      if (event[0] > time) continue;
      if (event[1] === 'o') {
        output += event[2];
        continue;
      }
      await flush();
      const match = RESIZE.exec(event[2])!;
      term.resize(Number(match[1]), Number(match[2]));
    }
    await flush();
    const top = term.buffer.active.baseY;
    return Array.from({ length: term.rows }, (_, row) => (
      term.buffer.active.getLine(top + row)?.translateToString(true).trimEnd() ?? ''
    ));
  } finally {
    term.dispose();
  }
}

export async function playCast(
  cast: CliCast,
  speed: number,
  write: (text: string) => void,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let previousTime = 0;
  for (const event of cast.events) {
    await sleep(Math.max(0, event[0] - previousTime) * 1_000 / speed);
    previousTime = event[0];
    if (event[1] === 'o') write(event[2]);
  }
}
