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
  const line = lastNonEmptyLine(input.lines);
  if (line === undefined) return { ...base, ready: false, source: 'screen', detail: 'screen is empty' };
  if (BUSY.test(line)) return { ...base, ready: false, source: 'screen', detail: `busy: ${line.trim()}` };
  if (IDLE_PROMPT.test(line) || COMPOSER.test(line) || QUESTION.test(line)) {
    return { ...base, ready: true, source: 'screen', detail: `prompt: ${line.trim()}` };
  }
  return { ...base, ready: false, source: 'screen', detail: `no prompt: ${line.trim().slice(0, 80)}` };
}
