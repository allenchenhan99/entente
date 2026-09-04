import type { TaskView } from '@relay/protocol';

import type { CanvasColor, CellStyle } from './canvas.js';

export interface TaskEdgeVisuals {
  planner: {
    label: string;
    color: CanvasColor;
    dotted: boolean;
    bold: boolean;
    dim: boolean;
  };
  verifier: {
    label: string;
    color: CanvasColor;
    dotted: boolean;
    particle: boolean;
  };
  repairLabel?: string;
}

export function edgeVisuals(task: TaskView, tick: number): TaskEdgeVisuals {
  const version = `v${task.contract.version}`;
  const proposedPulseDim = tick % 8 < 4;
  const clarificationBold = tick % 4 < 2;

  let planner: TaskEdgeVisuals['planner'];
  switch (task.handoff_state) {
    case 'needs_clarification':
      planner = {
        label: `? ${task.open_questions.length}`,
        color: 'amber',
        dotted: false,
        bold: clarificationBold,
        dim: false,
      };
      break;
    case 'accepted':
    case 'verified':
    case 'evidence_submitted':
      planner = { label: `${version} ✓`, color: 'green', dotted: false, bold: false, dim: false };
      break;
    case 'retry_requested':
      planner = { label: `${version} !`, color: 'red', dotted: false, bold: true, dim: false };
      break;
    case 'rejected':
      planner = { label: `${version} rejected`, color: 'red', dotted: false, bold: false, dim: false };
      break;
    default:
      planner = { label: version, color: 'gray', dotted: true, bold: false, dim: proposedPulseDim };
  }

  if (task.handoff_state === 'verified') {
    return {
      planner,
      verifier: { label: '✓', color: 'green', dotted: false, particle: false },
    };
  }
  if (task.handoff_state === 'evidence_submitted') {
    return {
      planner,
      verifier: { label: '', color: 'green', dotted: true, particle: true },
    };
  }
  if (task.handoff_state === 'retry_requested') {
    return {
      planner,
      verifier: { label: 'failed', color: 'red', dotted: true, particle: false },
      repairLabel: task.active_repair?.failed_criteria.join(', ') ?? 'retry',
    };
  }
  return {
    planner,
    verifier: { label: 'awaiting evidence', color: 'gray', dotted: true, particle: false },
  };
}

export function edgeStyle(visual: { color: CanvasColor; bold?: boolean; dim?: boolean }): CellStyle {
  return { color: visual.color, bold: visual.bold, dim: visual.dim };
}
