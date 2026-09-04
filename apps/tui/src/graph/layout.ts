import type { Graph, GraphColumn } from '@relay/protocol';

export interface GraphLayout {
  columns: Record<GraphColumn, number>;
  nodeRows: Record<string, number>;
  edgeRows: Record<string, number>;
}

export function layoutGraph(graph: Graph, width: number): GraphLayout {
  const safeWidth = Math.max(40, width);
  const columns: Record<GraphColumn, number> = {
    0: 0,
    1: Math.max(18, Math.floor(safeWidth * 0.25)),
    2: Math.max(36, Math.floor(safeWidth * 0.62)),
    3: Math.max(48, safeWidth - 16),
  };
  const columnCounts = new Map<GraphColumn, number>();
  const nodeRows: Record<string, number> = {};
  for (const node of graph.nodes) {
    const index = columnCounts.get(node.column) ?? 0;
    nodeRows[node.id] = 1 + index;
    columnCounts.set(node.column, index + 1);
  }
  const nodeDepth = Math.max(0, ...columnCounts.values());
  const edgeRows = Object.fromEntries(graph.edges.map((edge, index) => [edge.id, nodeDepth + 2 + index]));
  return { columns, nodeRows, edgeRows };
}
