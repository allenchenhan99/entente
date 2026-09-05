/**
 * Screen-tier readiness (PRD §23, `PaneReadiness.source = 'screen'`): can the pane accept a prompt right now?
 * Pure over a snapshot of the visible lines and the time of the last output byte, so it is trivially testable.
 * Declared / hook tiers are later work packages.
 */
import type { PaneReadiness } from '@relay/protocol';

/** No output for this long counts as "quiet". */
export const QUIET_MS = 400;

/** Idle shell prompts and bare composers: `$ `, `❯ `, `> `, `› ` … */
const IDLE_PROMPT = /^[❯>›$%#]\s*$/;
/** Claude Code (`> `) and Codex (`› `) composers with placeholder text. */
const COMPOSER = /^(> |› )/;
/** A question waiting for the human. */
const QUESTION = /\?\s*$/;
/** The agent is visibly working. */
const BUSY = /(esc to interrupt|Working|Thinking|Running)/i;
/**
 * Chrome that sits *below* the prompt in agent TUIs and must not be mistaken for the last meaningful line:
 * Claude Code's permission/status bar, Codex's model/cwd footer, box-drawing rules.
 */
const CHROME = /(bypass permissions|shift\+tab|^\s*⏵|^\s*gpt-\d|· ~\/|\/rc\s*$|^[\s─━╭╰│╮╯┃]+$)/;
/** How many trailing non-empty lines are examined for a prompt. */
const TAIL_LINES = 8;

export interface ReadinessInput {
  paneId: string;
  /** Visible rows, top to bottom. */
  lines: string[];
  /** Epoch ms of the last output byte (undefined = no output yet). */
  lastOutputAt: number | undefined;
  now: number;
  quietMs?: number;
  exited: boolean;
  /** ISO clock for `observed_at`; defaults to `new Date(now)`. */
  observedAt?: string;
}

/**
 * The "visibly working" line in the tail, if any — independent of whether output is still flowing (a spinner
 * repaints every few hundred ms, so a quiet-gated readiness never reports it).
 */
export const busyLine = (lines: string[]): string | undefined => {
  const tail = lines.filter((l) => l.trim().length > 0).slice(-TAIL_LINES).filter((l) => !CHROME.test(l));
  return tail.find((l) => BUSY.test(l));
};

/** The last non-empty line that is not footer chrome: where an agent TUI's composer sits. */
export const lastMeaningfulLine = (lines: string[]): string | undefined => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim().length > 0 && !CHROME.test(line)) return line;
  }
  return undefined;
};

export const lastNonEmptyLine = (lines: string[]): string | undefined => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim().length > 0) return line;
  }
  return undefined;
};

export function evaluateReadiness(input: ReadinessInput): PaneReadiness {
  const observed_at = input.observedAt ?? new Date(input.now).toISOString();
  const quietMs = input.quietMs ?? QUIET_MS;
  const base = { pane_id: input.paneId, observed_at };
  if (input.exited) return { ...base, ready: false, source: 'unknown', detail: 'pane exited' };
  const sinceOutput = input.lastOutputAt === undefined ? Infinity : input.now - input.lastOutputAt;
  if (sinceOutput < quietMs) return { ...base, ready: false, source: 'screen', detail: `output flowing (${Math.round(sinceOutput)} ms ago)` };
  const tail = input.lines.filter((l) => l.trim().length > 0).slice(-TAIL_LINES);
  if (tail.length === 0) return { ...base, ready: false, source: 'screen', detail: 'screen is empty' };
  const meaningful = tail.filter((l) => !CHROME.test(l));
  const busy = meaningful.find((l) => BUSY.test(l));
  if (busy) return { ...base, ready: false, source: 'screen', detail: `busy: ${busy.trim().slice(0, 80)}` };
  // Prefer the lowest prompt-like line: the composer sits above the footer chrome.
  for (let i = meaningful.length - 1; i >= 0; i--) {
    const line = meaningful[i]!;
    if (IDLE_PROMPT.test(line) || COMPOSER.test(line) || QUESTION.test(line)) {
      return { ...base, ready: true, source: 'screen', detail: `prompt: ${line.trim().slice(0, 80)}` };
    }
  }
  const last = lastNonEmptyLine(input.lines) ?? '';
  return { ...base, ready: false, source: 'screen', detail: `no prompt: ${last.trim().slice(0, 80)}` };
}
