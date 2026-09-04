import type { State, TaskView } from '@relay/protocol';
import { Text } from 'ink';

import { Canvas, type CellStyle } from './canvas.js';
import { edgeStyle, edgeVisuals } from './edges.js';
import { layoutGraph } from './layout.js';

export interface RenderGraphOptions {
  width: number;
  height: number;
  tick: number;
  selectedTaskId?: string;
}

export interface GraphProps extends RenderGraphOptions {
  state: State;
}

function runtimeGlyph(task: TaskView): string {
  switch (task.runtime) {
    case 'working': return '●';
    case 'idle': return '○';
    case 'blocked': return '◐';
    case 'done': return '✓';
    case 'exited': return '✗';
    case 'unspawned': return '·';
    default: return '?';
  }
}

function drawHorizontalEdge(options: {
  canvas: Canvas;
  fromX: number;
  toX: number;
  y: number;
  label: string;
  style: CellStyle;
  dotted: boolean;
  tick: number;
  particle?: boolean;
}): void {
  const { canvas, fromX, toX, y, label, style, dotted, tick, particle = false } = options;
  const length = Math.max(0, toX - fromX);
  for (let offset = 0; offset < length; offset += 1) {
    const ch = dotted && (offset + tick) % 2 === 1 ? ' ' : (dotted ? '╌' : '─');
    canvas.text(fromX + offset, y, ch, style);
  }
  canvas.text(toX, y, '▶', style);

  if (label !== '' && length > label.length + 2) {
    const labelX = fromX + Math.max(1, Math.floor((length - label.length) / 2));
    canvas.text(labelX, y, label, style);
  }
  if (particle && length > 0) {
    canvas.text(fromX + Math.min(tick, length - 1), y, '●', { color: 'green', bold: true });
  }
}

function drawTask(canvas: Canvas, task: TaskView, options: RenderGraphOptions, row: number, columns: ReturnType<typeof layoutGraph>['columns']): void {
  const selected = task.id === options.selectedTaskId;
  const visuals = edgeVisuals(task, options.tick);
  const plannerStyle = { ...edgeStyle(visuals.planner), bold: selected || visuals.planner.bold };
  const verifierStyle = { ...edgeStyle(visuals.verifier), bold: selected };

  canvas.text(columns.planner, row, 'planner', { color: 'white', dim: task.handoff_state === 'proposed' });
  drawHorizontalEdge({
    canvas,
    fromX: columns.planner + 8,
    toX: columns.tasks - 2,
    y: row,
    label: visuals.planner.label,
    style: plannerStyle,
    dotted: visuals.planner.dotted,
    tick: options.tick,
  });

  const taskLabel = `${runtimeGlyph(task)} ${task.contract.recipient} a${task.attempt}`;
  canvas.text(columns.tasks, row, taskLabel, {
    color: task.handoff_state === 'retry_requested' ? 'red' : 'white',
    bold: selected || task.handoff_state === 'accepted' || task.handoff_state === 'verified',
    dim: task.handoff_state === 'proposed' || task.handoff_state === 'needs_clarification',
  });
  const verifierStart = Math.min(columns.verifier - 3, columns.tasks + Math.max(14, taskLabel.length + 1));
  drawHorizontalEdge({
    canvas,
    fromX: verifierStart,
    toX: columns.verifier - 2,
    y: row,
    label: visuals.verifier.label,
    style: verifierStyle,
    dotted: visuals.verifier.dotted,
    tick: options.tick,
    particle: visuals.verifier.particle,
  });
  canvas.text(columns.verifier, row, 'verifier', { color: visuals.verifier.color, bold: selected });

  if (task.handoff_state === 'verified') {
    drawHorizontalEdge({
      canvas,
      fromX: columns.verifier + 9,
      toX: columns.done - 2,
      y: row,
      label: '',
      style: { color: 'green' },
      dotted: false,
      tick: options.tick,
    });
    canvas.text(columns.done, row, 'done', { color: 'green', bold: true });
  }

  const detailRow = row + 1;
  if (visuals.repairLabel) {
    canvas.text(columns.tasks, detailRow, `◀── ${visuals.repairLabel} ── verifier`, { color: 'red', bold: true });
  }
  if (task.blocked_on_dependencies.length > 0) {
    const dependency = task.blocked_on_dependencies[0]!;
    canvas.text(1, detailRow, `▲ dep ${dependency}`, { color: 'cyan' });
    canvas.text(columns.tasks, detailRow, `◐ blocked on ${dependency}`, { color: 'amber', bold: true });
  }
}

export function renderGraph(state: State, options: RenderGraphOptions): string[] {
  const canvas = new Canvas(options.width, options.height);
  const layout = layoutGraph(state, options.width, options.height);
  canvas.text(layout.columns.planner, 0, 'PLANNER', { color: 'gray', bold: true });
  canvas.text(layout.columns.tasks, 0, 'CODING AGENTS', { color: 'gray', bold: true });
  canvas.text(layout.columns.verifier, 0, 'VERIFIER', { color: 'gray', bold: true });
  canvas.text(layout.columns.done, 0, 'DONE', { color: 'gray', bold: true });

  for (const taskId of layout.taskIds) {
    const task = state.tasks[taskId]!;
    const row = layout.taskRows[taskId]!;
    drawTask(canvas, task, options, row, layout.columns);
  }
  return canvas.render();
}

export function Graph({ state, ...options }: GraphProps) {
  return <Text>{renderGraph(state, options).join('\n')}</Text>;
}
