import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'unbounded_retry',
  severity: 'error',
  check(contract) {
    return contract.budget === undefined
      ? [result('unbounded_retry', 'error', contract, 'budget.max_repairs is not set; repairs would be unbounded', 'budget')]
      : [];
  },
};
