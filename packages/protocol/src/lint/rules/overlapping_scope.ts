import type { LintRule } from '../../lint.js';
import { isSameOrAncestor, normalizeGlob, result } from '../util.js';

/**
 * Two allowed_paths globs overlap when, after stripping trailing `/**` and `/*`, one equals the other
 * or is a directory ancestor of it (in either direction). Simple string comparison, no glob engine.
 */
export const rule: LintRule = {
  id: 'overlapping_scope',
  severity: 'warning',
  check(contract, ctx) {
    return (contract.scope?.allowed_paths ?? []).flatMap((glob, i) => {
      const mine = normalizeGlob(glob);
      for (const sibling of ctx.siblings) {
        if (sibling.id === contract.id) continue;
        for (const theirGlob of sibling.scope?.allowed_paths ?? []) {
          const theirs = normalizeGlob(theirGlob);
          if (isSameOrAncestor(mine, theirs) || isSameOrAncestor(theirs, mine)) {
            return [result('overlapping_scope', 'warning', contract, `allowed path "${glob}" overlaps "${theirGlob}" of task ${sibling.id}`, `scope/allowed_paths/${i}`)];
          }
        }
      }
      return [];
    });
  },
};
