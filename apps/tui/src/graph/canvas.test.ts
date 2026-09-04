import { describe, expect, it } from 'vitest';

import { Canvas, stripAnsi } from './canvas.js';

describe('canvas', () => {
  it('clips text at both horizontal bounds', () => {
    const canvas = new Canvas(5, 2);

    canvas.text(-2, 0, 'ABCDE');
    canvas.text(3, 1, 'WXYZ');

    expect(canvas.render().map(stripAnsi)).toEqual(['CDE  ', '   WX']);
  });

  it('draws bounded horizontal and vertical lines', () => {
    const canvas = new Canvas(5, 3);

    canvas.hline(-2, 1, 7);
    canvas.vline(2, -1, 5);

    expect(canvas.render().map(stripAnsi)).toEqual(['  │  ', '──│──', '  │  ']);
  });

  it('draws a horizontal-then-vertical arrow with line, corner, and head glyphs', () => {
    const canvas = new Canvas(8, 4);

    canvas.arrow({ x: 1, y: 0 }, { x: 6, y: 3 });

    const frame = canvas.render().map(stripAnsi);
    expect(frame[0]).toBe(' ─────┐ ');
    expect(frame[1]).toBe('      │ ');
    expect(frame[2]).toBe('      │ ');
    expect(frame[3]).toBe('      ▶ ');
  });

  it('renders ANSI styles while preserving exact dimensions', () => {
    const canvas = new Canvas(6, 3);
    canvas.text(0, 0, 'hot', { color: 'amber', bold: true });
    canvas.text(0, 1, 'quiet', { color: 'gray', dim: true });

    const rendered = canvas.render();
    expect(rendered[0]).toContain('\u001b[');
    expect(rendered).toHaveLength(3);
    for (const row of rendered) expect([...stripAnsi(row)]).toHaveLength(6);
  });

  it('ignores writes outside the vertical bounds', () => {
    const canvas = new Canvas(4, 2);
    canvas.text(0, -1, 'nope');
    canvas.text(0, 2, 'nope');

    expect(canvas.render().map(stripAnsi)).toEqual(['    ', '    ']);
  });
});
