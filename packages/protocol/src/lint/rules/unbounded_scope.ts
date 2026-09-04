import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'unbounded_scope',
  severity: 'error',
  check(contract) {
    const paths = contract.scope?.allowed_paths ?? [];
    return paths.length === 0 ? [result('unbounded_scope', 'error', contract, 'scope.allowed_paths is empty; the diff would be unbounded', 'scope/allowed_paths')] : [];
  },
};
