import { describe, it, expect } from 'vitest';
import { TaskContract } from '@relay/protocol';
import { lintContract } from '../lint.js';

const base = TaskContract.parse({
  id: 't-a', mission_id: 'm-1', version: 1, sender: 'planner', recipient: 'backend', runtime: 'claude-code',
  goal: 'do it',
  acceptance_criteria: [{ id: 'AC-1', condition: 'works', check: { kind: 'command', run: 'true' } }],
});
const ctx = { siblings: [], repoRoot: '/repo', fileExists: () => true };

describe('lint shim', () => {
  it('returns no errors for a verifiable contract', () => {
    expect(lintContract(base, ctx).filter((r) => r.severity === 'error')).toEqual([]);
  });
  it('reports an error when there are no acceptance criteria', () => {
    const results = lintContract({ ...base, acceptance_criteria: [] }, ctx);
    expect(results.some((r) => r.rule === 'no_acceptance_criteria' && r.severity === 'error')).toBe(true);
    expect(results.every((r) => r.task_id === 't-a')).toBe(true);
  });
  it('reports an error for a criterion without a check', () => {
    const results = lintContract(
      { ...base, acceptance_criteria: [{ id: 'AC-1', condition: 'x' }] },
      ctx,
    );
    expect(results.some((r) => r.rule === 'unverifiable_criterion' && r.severity === 'error')).toBe(true);
  });
});
