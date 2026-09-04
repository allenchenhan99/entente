import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'no_evidence_required',
  severity: 'warning',
  check(contract) {
    return (contract.output?.evidence_required ?? []).length === 0
      ? [result('no_evidence_required', 'warning', contract, 'output.evidence_required is empty; "done" would be unproven', 'output/evidence_required')]
      : [];
  },
};
