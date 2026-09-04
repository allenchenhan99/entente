import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'no_non_goals',
  severity: 'warning',
  check(contract) {
    return (contract.non_goals ?? []).length === 0 ? [result('no_non_goals', 'warning', contract, 'no non_goals listed; scope creep is likely', 'non_goals')] : [];
  },
};
