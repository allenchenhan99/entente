/**
 * Server-side screen model: a `ScreenSnapshot` read from a headless xterm buffer (PRD §23, `ReadScreenQuery`).
 * `visible` = the viewport; `recent` = up to `lines` scrollback rows followed by the viewport.
 */
import type { Terminal } from '@xterm/headless';
import type { ScreenSnapshot } from '@relay/protocol';

export interface ScreenQuery {
  source: 'visible' | 'recent';
  lines: number;
}

const rowText = (term: Terminal, y: number): string => term.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? '';

export function readScreen(term: Terminal, paneId: string, query: ScreenQuery): ScreenSnapshot {
  const buffer = term.buffer.active;
  const top = buffer.baseY;
  const start = query.source === 'recent' ? Math.max(0, top - query.lines) : top;
  const lines: string[] = [];
  for (let y = start; y < top + term.rows; y++) lines.push(rowText(term, y));
  return {
    pane_id: paneId,
    cols: term.cols,
    rows: term.rows,
    lines,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    alternate: buffer.type === 'alternate',
    scrollback_lines: top,
  };
}
