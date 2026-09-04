import type { VisualStatus } from '@relay/protocol';

import type { CanvasColor, CellStyle } from './canvas.js';

export interface StatusVisual {
  color: CanvasColor;
  bold: boolean;
  dim: boolean;
  glyph: string;
  line: string;
}

export function statusVisual(status: VisualStatus, tick: number): StatusVisual {
  switch (status) {
    case 'pending':
      return { color: 'gray', bold: false, dim: tick % 8 < 4, glyph: '·', line: tick % 2 === 0 ? '╌ ╌' : ' ╌ ' };
    case 'attention':
      return { color: 'amber', bold: tick % 4 < 2, dim: false, glyph: '!', line: '?──' };
    case 'blocked':
      return { color: 'amber', bold: true, dim: false, glyph: '◐', line: '◐──' };
    case 'working':
      return { color: 'cyan', bold: false, dim: false, glyph: '●', line: tick % 2 === 0 ? '╌─╌' : '─╌─' };
    case 'done':
    case 'verified':
      return { color: 'green', bold: status === 'verified', dim: false, glyph: '✓', line: '───' };
    case 'failed':
      return { color: 'red', bold: true, dim: false, glyph: '✗', line: '─✗─' };
  }
}

export function statusStyle(status: VisualStatus, tick: number, selected: boolean): CellStyle {
  const visual = statusVisual(status, tick);
  return {
    color: visual.color,
    bold: selected || visual.bold,
    dim: visual.dim,
    inverse: selected,
  };
}
