import type { Graph as ObjectGraph, GraphObjectRef } from '@relay/protocol';
import { Text } from 'ink';
import React from 'react';

import { Canvas } from './canvas.js';
import { statusStyle, statusVisual } from './edges.js';
import { layoutGraph } from './layout.js';

export interface RenderGraphOptions {
  width: number;
  height: number;
  tick: number;
  selected?: GraphObjectRef;
}

export interface GraphProps extends RenderGraphOptions {
  graph: ObjectGraph;
}

function isSelected(selected: GraphObjectRef | undefined, kind: 'node' | 'edge', id: string): boolean {
  return selected?.kind === kind && selected.id === id;
}

export function renderGraph(graph: ObjectGraph, options: RenderGraphOptions): string[] {
  const canvas = new Canvas(options.width, options.height);
  if (graph.nodes.length === 0 && graph.edges.length === 0) {
    canvas.text(0, 0, '<empty graph>', { color: 'gray', dim: true });
    return canvas.render();
  }

  const layout = layoutGraph(graph, options.width);
  const selectedRow = options.selected?.kind === 'node'
    ? layout.nodeRows[options.selected.id]
    : options.selected?.kind === 'edge'
      ? layout.edgeRows[options.selected.id]
      : undefined;
  const contentHeight = Math.max(0, options.height - 1);
  const rowOffset = selectedRow !== undefined && selectedRow > contentHeight
    ? selectedRow - contentHeight
    : 0;
  const visibleRow = (logicalRow: number) => logicalRow - rowOffset;
  const headings = ['HUMAN / PLANNER', 'AGENTS', 'VERIFIER', 'DONE'] as const;
  for (const column of [0, 1, 2, 3] as const) {
    canvas.text(layout.columns[column], 0, headings[column], { color: 'gray', bold: true });
  }

  for (const node of graph.nodes) {
    const selected = isSelected(options.selected, 'node', node.id);
    const visual = statusVisual(node.status, options.tick);
    const badge = node.badge ? ` ${node.badge}` : '';
    const identity = node.label === node.id ? node.id : `${node.id} (${node.label})`;
    const y = visibleRow(layout.nodeRows[node.id]!);
    if (y <= 0) continue;
    canvas.text(
      layout.columns[node.column],
      y,
      `${visual.glyph} ${identity}${badge}`,
      statusStyle(node.status, options.tick, selected),
    );
  }

  for (const edge of graph.edges) {
    const selected = isSelected(options.selected, 'edge', edge.id);
    const visual = statusVisual(edge.status, options.tick);
    const y = visibleRow(layout.edgeRows[edge.id]!);
    if (y <= 0) continue;
    canvas.text(
      0,
      y,
      `[${edge.id}] ${edge.from} ${visual.line} ${edge.label} ▶ ${edge.to}`,
      statusStyle(edge.status, options.tick, selected),
    );
  }
  return canvas.render();
}

export function Graph({ graph, ...options }: GraphProps) {
  return <Text>{renderGraph(graph, options).join('\n')}</Text>;
}
