import { describe, expect, it } from 'vitest';

import { happyState, midClarificationState, midRepairState } from '../__fixtures__/states.js';
import { stripAnsi } from './canvas.js';
import { renderGraph } from './Graph.js';

function plainGraph(state: typeof happyState, tick = 0): string {
  return renderGraph(state, { width: 100, height: 12, tick }).map(stripAnsi).join('\n');
}

describe('graph states', () => {
  it('shows clarification and accepted contract edges from the clarification fixture', () => {
    const frame = plainGraph(midClarificationState);

    expect(frame).toContain('frontend');
    expect(frame).toContain('? 2');
    expect(frame).toContain('backend');
    expect(frame).toContain('v2 ✓');
  });

  it('styles the clarification badge amber and pulses its bold weight', () => {
    const boldFrame = renderGraph(midClarificationState, { width: 100, height: 12, tick: 0 }).join('\n');
    const normalFrame = renderGraph(midClarificationState, { width: 100, height: 12, tick: 2 }).join('\n');

    expect(boldFrame).toContain('\u001b[1;33m?');
    expect(normalFrame).toContain('\u001b[33m?');
  });

  it('shows dependency direction and the blocked dependency task', () => {
    const frame = plainGraph(midClarificationState);

    expect(frame).toContain('▲ dep t-backend-auth');
    expect(frame).toContain('◐ blocked on t-backend-auth');
  });

  it('shows a red verifier back-edge labelled with failed criteria during repair', () => {
    const rendered = renderGraph(midRepairState, { width: 100, height: 12, tick: 1 }).join('\n');

    expect(stripAnsi(rendered)).toContain('◀');
    expect(stripAnsi(rendered)).toContain('AC-2');
    expect(rendered).toContain('\u001b[31m');
  });

  it('shows verified checks on every task edge in the happy fixture', () => {
    const lines = plainGraph(happyState).split('\n').filter((line) => line.includes('planner'));

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.match(/✓/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('shifts dotted edges by tick and moves an evidence particle', () => {
    const proposedAtTick0 = plainGraph(midClarificationState, 0);
    const proposedAtTick1 = plainGraph(midClarificationState, 1);
    expect(proposedAtTick0).not.toBe(proposedAtTick1);

    const evidenceState = {
      ...midClarificationState,
      tasks: {
        ...midClarificationState.tasks,
        't-backend-auth': {
          ...midClarificationState.tasks['t-backend-auth']!,
          handoff_state: 'evidence_submitted' as const,
          task_state: 'awaiting_verification' as const,
        },
      },
    };
    const particleAtTick0 = plainGraph(evidenceState, 0);
    const particleAtTick3 = plainGraph(evidenceState, 3);

    expect(particleAtTick0).toContain('●');
    expect(particleAtTick0).not.toBe(particleAtTick3);

    const lateLine = plainGraph(evidenceState, 100).split('\n').find((line) => line.includes('backend'))!;
    const laterLine = plainGraph(evidenceState, 101).split('\n').find((line) => line.includes('backend'))!;
    expect(lateLine.lastIndexOf('●')).toBe(laterLine.lastIndexOf('●'));
  });
});
