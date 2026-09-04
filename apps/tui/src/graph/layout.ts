import type { State } from '@relay/protocol';

export interface GraphColumns {
  planner: number;
  tasks: number;
  verifier: number;
  done: number;
}

export interface GraphLayout {
  columns: GraphColumns;
  taskRows: Record<string, number>;
  taskIds: string[];
}

export function layoutGraph(state: State, width: number, height: number): GraphLayout {
  const taskIds = Object.keys(state.tasks).sort();
  const safeWidth = Math.max(40, width);
  const columns: GraphColumns = {
    planner: 0,
    tasks: Math.max(18, Math.floor(safeWidth * 0.25)),
    verifier: Math.max(42, Math.floor(safeWidth * 0.67)),
    done: Math.max(52, safeWidth - 6),
  };
  const availableRows = Math.max(taskIds.length, height - 2);
  const rowStep = Math.max(2, Math.floor(availableRows / Math.max(1, taskIds.length)));
  const taskRows = Object.fromEntries(taskIds.map((taskId, index) => [taskId, 1 + index * rowStep]));

  return { columns, taskRows, taskIds };
}
