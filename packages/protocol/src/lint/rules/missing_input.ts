import type { LintRule } from '../../lint.js';
import { result, globMatches } from '../util.js';

/**
 * Inputs must exist in the repository — unless a dependency of this task is going to produce them:
 * a path inside a dependency's `scope.allowed_paths` will exist once that dependency's branch is
 * merged into this task's worktree base, so referencing it is exactly how a consumer should describe
 * its interface to a producer.
 */
export const rule: LintRule = {
  id: 'missing_input',
  severity: 'error',
  check(contract, ctx) {
    const dependencyGlobs = ctx.siblings
      .filter((s) => contract.dependencies.includes(s.id))
      .flatMap((s) => s.scope.allowed_paths);
    const producedByDependency = (input: string) => dependencyGlobs.some((g) => globMatches(g, input));
    return (contract.inputs ?? []).flatMap((input, i) =>
      ctx.fileExists(input) || producedByDependency(input)
        ? []
        : [result('missing_input', 'error', contract, `input "${input}" does not exist under ${ctx.repoRoot}`, `inputs/${i}`)],
    );
  },
};
