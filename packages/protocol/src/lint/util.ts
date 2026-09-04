/** Small helpers shared by lint rules. */
import type { LintResult, LintRuleId, LintSeverity } from '../lint.js';
import type { TaskContract } from '../contract.js';

export const result = (rule: LintRuleId, severity: LintSeverity, contract: Pick<TaskContract, 'id'>, message: string, field?: string): LintResult => ({
  rule,
  severity,
  message,
  task_id: contract.id ?? '',
  ...(field !== undefined ? { field } : {}),
});

/** Strip trailing `/**` and `/*` so globs can be compared as path prefixes. */
export const normalizeGlob = (glob: string): string => glob.replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');

/** True when `a` equals `b` or is a directory ancestor of `b` (after normalization). */
export const isSameOrAncestor = (a: string, b: string): boolean => a === b || b.startsWith(a + '/');
