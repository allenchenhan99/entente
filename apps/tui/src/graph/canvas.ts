export type CanvasColor = 'gray' | 'amber' | 'green' | 'red' | 'cyan' | 'white';

export interface CellStyle {
  color?: CanvasColor;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

interface Cell extends CellStyle {
  ch: string;
}

const RESET = '\u001b[0m';
const COLOR_CODES: Record<CanvasColor, number> = {
  gray: 90,
  amber: 33,
  green: 32,
  red: 31,
  cyan: 36,
  white: 37,
};

function ansiPrefix(cell: Cell): string {
  const codes: number[] = [];
  if (cell.bold) codes.push(1);
  if (cell.dim) codes.push(2);
  if (cell.inverse) codes.push(7);
  if (cell.color) codes.push(COLOR_CODES[cell.color]);
  return codes.length === 0 ? '' : `\u001b[${codes.join(';')}m`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly cells: Cell[][];

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.cells = Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => ({ ch: ' ' })),
    );
  }

  text(x: number, y: number, value: string, style: CellStyle = {}): void {
    if (y < 0 || y >= this.height) return;
    for (const [offset, ch] of [...value].entries()) {
      this.set(x + offset, y, ch, style);
    }
  }

  hline(x: number, y: number, length: number, style: CellStyle = {}, ch = '─'): void {
    const direction = length < 0 ? -1 : 1;
    for (let offset = 0; offset < Math.abs(length); offset += 1) {
      this.set(x + offset * direction, y, ch, style);
    }
  }

  vline(x: number, y: number, length: number, style: CellStyle = {}, ch = '│'): void {
    const direction = length < 0 ? -1 : 1;
    for (let offset = 0; offset < Math.abs(length); offset += 1) {
      this.set(x, y + offset * direction, ch, style);
    }
  }

  arrow(from: Point, to: Point, style: CellStyle = {}): void {
    const horizontalDirection = to.x >= from.x ? 1 : -1;
    const horizontalLength = Math.abs(to.x - from.x);
    this.hline(from.x, from.y, horizontalDirection * horizontalLength, style);

    if (from.y === to.y) {
      this.set(to.x, to.y, horizontalDirection > 0 ? '▶' : '◀', style);
      return;
    }

    const verticalDirection = to.y > from.y ? 1 : -1;
    const corner = horizontalDirection > 0
      ? (verticalDirection > 0 ? '┐' : '┘')
      : (verticalDirection > 0 ? '┌' : '└');
    this.set(to.x, from.y, corner, style);
    this.vline(to.x, from.y + verticalDirection, verticalDirection * (Math.abs(to.y - from.y) - 1), style);
    this.set(to.x, to.y, horizontalDirection > 0 ? '▶' : '◀', style);
  }

  render(): string[] {
    return this.cells.map((row) => row.map((cell) => {
      const prefix = ansiPrefix(cell);
      return prefix === '' ? cell.ch : `${prefix}${cell.ch}${RESET}`;
    }).join(''));
  }

  private set(x: number, y: number, ch: string, style: CellStyle): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.cells[y]![x] = { ch, ...style };
  }
}
