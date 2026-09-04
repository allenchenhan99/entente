import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'unverifiable_criterion',
  severity: 'error',
  check(contract) {
    return (contract.acceptance_criteria ?? []).flatMap((ac, i) =>
      ac.check === undefined
        ? [result('unverifiable_criterion', 'error', contract, `criterion ${ac.id} has no check and cannot be verified`, `acceptance_criteria/${i}/check`)]
        : [],
    );
  },
};
