import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'unknown_dependency',
  severity: 'error',
  check(contract, ctx) {
    const known = new Set<string>([contract.id, ...ctx.siblings.map((s) => s.id)]);
    return (contract.dependencies ?? []).flatMap((dep, i) =>
      known.has(dep) ? [] : [result('unknown_dependency', 'error', contract, `dependency "${dep}" is not a task in this mission`, `dependencies/${i}`)],
    );
  },
};
