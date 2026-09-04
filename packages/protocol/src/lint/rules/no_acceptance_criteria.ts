import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'no_acceptance_criteria',
  severity: 'error',
  check(contract) {
    const acs = contract.acceptance_criteria ?? [];
    return acs.length === 0 ? [result('no_acceptance_criteria', 'error', contract, 'contract has no acceptance criteria', 'acceptance_criteria')] : [];
  },
};
