import { describe, expect, it } from 'vitest';

import { objectGraph } from '../__fixtures__/graph.js';
import { stripAnsi } from './canvas.js';
import { renderGraph } from './Graph.js';

function plainGraph(tick = 0): string {
  return renderGraph(objectGraph, { width: 100, height: 12, tick }).map(stripAnsi).join('\n');
}

describe('graph objects', () => {
  it('renders nodes and exact edge labels in protocol order', () => {
    const frame = plainGraph();

    expect(frame).toContain('t-backend-auth (backend)');
    expect(frame).toContain('t-frontend-login (frontend)');
    expect(frame).toContain('v2 ✓');
    expect(frame).toContain('? 2');
    expect(frame).toContain('AC-2 ✗');
    expect(frame.indexOf('edge-backend-contract')).toBeLessThan(frame.indexOf('edge-frontend-contract'));
  });

  it('maps attention to pulsing amber and failed objects to red', () => {
    const boldFrame = renderGraph(objectGraph, { width: 100, height: 12, tick: 0 }).join('\n');
    const normalFrame = renderGraph(objectGraph, { width: 100, height: 12, tick: 2 }).join('\n');

    expect(boldFrame).toContain('\u001b[1;33m');
    expect(normalFrame).toContain('\u001b[33m');
    expect(boldFrame).toContain('\u001b[1;31m');
    expect(stripAnsi(boldFrame)).toContain('◐ t-backend-auth (backend)');
  });

  it.each([
    { kind: 'node', id: 't-backend-auth' } as const,
    { kind: 'edge', id: 'edge-backend-contract' } as const,
  ])('draws selected $kind $id bold and inverse', (selected) => {
    const frame = renderGraph(objectGraph, { width: 100, height: 12, tick: 0, selected }).join('\n');
    const selectedAnsi = frame.split('\n').find((line) => stripAnsi(line).includes(selected.id)) ?? '';
    expect(selectedAnsi).toContain('\u001b[1;7;');
  });

  it('animates pending breathing and working flowing dashes by tick', () => {
    const animated = {
      ...objectGraph,
      edges: objectGraph.edges.map((edge, index) => index === 0 ? { ...edge, status: 'pending' as const } : edge),
    };
    const tick0 = renderGraph(animated, { width: 100, height: 12, tick: 0 }).join('\n');
    const tick1 = renderGraph(animated, { width: 100, height: 12, tick: 1 }).join('\n');
    const tick4 = renderGraph(animated, { width: 100, height: 12, tick: 4 }).join('\n');

    expect(stripAnsi(tick0)).not.toBe(stripAnsi(tick1));
    expect(tick0).toContain('\u001b[2;90m');
    expect(tick4).not.toContain('\u001b[2;90m');
  });

  it('renders a sensible empty-graph placeholder', () => {
    const frame = renderGraph({ nodes: [], edges: [], inbox: [] }, { width: 40, height: 3, tick: 0 }).map(stripAnsi).join('\n');
    expect(frame).toContain('<empty graph>');
  });

  it('windows graph rows so a late selected edge stays highlighted', () => {
    const extraEdges = Array.from({ length: 6 }, (_, index) => ({
      ...objectGraph.edges[0]!,
      id: `edge-extra-${index}`,
      label: `extra ${index}`,
    }));
    const graph = { ...objectGraph, edges: [...objectGraph.edges, ...extraEdges] };
    const rendered = renderGraph(graph, {
      width: 80,
      height: 5,
      tick: 0,
      selected: { kind: 'edge', id: 'edge-extra-5' },
    }).join('\n');

    expect(stripAnsi(rendered)).toContain('edge-extra-5');
    expect(rendered).toContain('\u001b[1;7;');
  });
});
