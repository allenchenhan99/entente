import type { GraphObjectRef, State } from '@relay/protocol';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { objectGraph, objectGraphApi } from '../__fixtures__/graph.js';
import { midClarificationState, midRepairState } from '../__fixtures__/states.js';
import type { InputMode, OverlayTab } from '../keys.js';
import { Overlay, naiveContractDiff } from './Overlay.js';

const api = objectGraphApi();

function renderOverlay(
  state: State,
  objectRef: GraphObjectRef,
  tab: OverlayTab,
  inputMode?: InputMode,
  inputValue = '',
) {
  return render(
    <Overlay
      objectRef={objectRef}
      graph={objectGraph}
      state={state}
      events={[]}
      api={api}
      tab={tab}
      inputMode={inputMode}
      inputValue={inputValue}
    />,
  );
}

describe('overlay', () => {
  it('shows Story first and every task tab with all contract fields and a version diff', () => {
    const objectRef = { kind: 'node', id: 't-backend-auth' } as const;
    const task = midClarificationState.tasks['t-backend-auth']!;
    const { lastFrame } = renderOverlay(midClarificationState, objectRef, 'Contract');
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Story  [Contract]  Response  Questions  Evidence  History');
    expect(frame).toContain('goal: Implement secure magic-link authentication endpoints');
    expect(frame).toContain('allowed_paths: src/auth/**');
    expect(frame).toContain('acceptance_criteria:');
    expect(frame).toContain('-   "version": 1');
    expect(frame).toContain('+   "version": 2');
    expect(naiveContractDiff(task.versions[0]!, task.versions[1]!)).toContain('+   "version": 2');
  });

  it('renders response and question input content', () => {
    const backend = renderOverlay(midClarificationState, { kind: 'node', id: 't-backend-auth' }, 'Response');
    expect(backend.lastFrame()).toContain('interpretation:');
    expect(backend.lastFrame()).toContain('verification_plan:');

    const questions = renderOverlay(
      midClarificationState,
      { kind: 'node', id: 't-frontend-login' },
      'Questions',
      'answer',
      'Magic',
    );
    expect(questions.lastFrame()).toContain('Q1  Which empty state should be shown?');
    expect(questions.lastFrame()).toContain('answer> Magic');
  });

  it('highlights failed evidence, self-report mismatch, versions, and repair history', () => {
    const objectRef = { kind: 'node', id: 't-backend-auth' } as const;
    const evidence = renderOverlay(midRepairState, objectRef, 'Evidence');
    expect(evidence.lastFrame()).toContain('AC-2  failed  expected 401, received 200');
    expect(evidence.lastFrame()).toContain('SELF-REPORT MISMATCH: AC-2');

    const history = renderOverlay(midRepairState, objectRef, 'History');
    expect(history.lastFrame()).toContain('versions: v1 → v2');
    expect(history.lastFrame()).toContain('repair t-backend-auth/r1: AC-2');
  });

  it('limits non-task objects to Story', () => {
    const planner = renderOverlay(midClarificationState, { kind: 'node', id: 'planner' }, 'Contract');
    expect(planner.lastFrame()).toContain('planner  [Story]');
    expect(planner.lastFrame()).not.toContain('Contract  Response');
  });
});
