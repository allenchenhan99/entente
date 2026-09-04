import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { midClarificationState, midRepairState } from '../__fixtures__/states.js';
import { Overlay, naiveContractDiff } from './Overlay.js';

describe('overlay', () => {
  it('shows every tab and all contract fields with a previous-version diff', () => {
    const task = midClarificationState.tasks['t-backend-auth']!;
    const { lastFrame } = render(<Overlay task={task} tab="Contract" inputValue="" />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('[Contract]  Response  Questions  Evidence  History');
    expect(frame).toContain('goal: Implement secure magic-link authentication endpoints');
    expect(frame).toContain('allowed_paths: src/auth/**');
    expect(frame).toContain('acceptance_criteria:');
    expect(frame).toContain('-   "version": 1');
    expect(frame).toContain('+   "version": 2');
    expect(naiveContractDiff(task.versions[0]!, task.versions[1]!)).toContain('+   "version": 2');
  });

  it('renders response and question input content', () => {
    const backend = midClarificationState.tasks['t-backend-auth']!;
    const frontend = midClarificationState.tasks['t-frontend-login']!;
    const response = render(<Overlay task={backend} tab="Response" inputValue="" />);
    expect(response.lastFrame()).toContain('interpretation:');
    expect(response.lastFrame()).toContain('verification_plan:');

    const questions = render(<Overlay task={frontend} tab="Questions" inputMode="answer" inputValue="Magic" />);
    expect(questions.lastFrame()).toContain('Q1  Which empty state should be shown?');
    expect(questions.lastFrame()).toContain('answer> Magic');
  });

  it('highlights failed evidence, self-report mismatch, versions, and repair history', () => {
    const task = midRepairState.tasks['t-backend-auth']!;
    const evidence = render(<Overlay task={task} tab="Evidence" inputValue="" />);
    expect(evidence.lastFrame()).toContain('AC-2  failed  expected 401, received 200');
    expect(evidence.lastFrame()).toContain('SELF-REPORT MISMATCH: AC-2');

    const history = render(<Overlay task={task} tab="History" inputValue="" />);
    expect(history.lastFrame()).toContain('versions: v1 → v2');
    expect(history.lastFrame()).toContain('repair t-backend-auth/r1: AC-2');
  });
});
