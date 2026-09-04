import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'missing_goal',
  severity: 'error',
  check(contract) {
    const goal = (contract.goal ?? '').trim();
    return goal.length < 8 ? [result('missing_goal', 'error', contract, 'goal is empty or shorter than 8 characters', 'goal')] : [];
  },
};
