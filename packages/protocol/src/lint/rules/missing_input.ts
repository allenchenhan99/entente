import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

export const rule: LintRule = {
  id: 'missing_input',
  severity: 'error',
  check(contract, ctx) {
    return (contract.inputs ?? []).flatMap((input, i) =>
      ctx.fileExists(input) ? [] : [result('missing_input', 'error', contract, `input "${input}" does not exist under ${ctx.repoRoot}`, `inputs/${i}`)],
    );
  },
};
