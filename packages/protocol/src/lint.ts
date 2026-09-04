/**
 * Communication-debt lint. Rule-based, deterministic, runs on task_proposed and contract_revised.
 * See PRD.md §11. Rules live in ./lint/rules/*.ts — one file per rule (owned by the protocol agent).
 */
import { z } from 'zod';
import type { TaskContract } from './contract.js';

export const LintSeverity = z.enum(['error', 'warning', 'info']);
export type LintSeverity = z.infer<typeof LintSeverity>;

export const LintRuleId = z.enum([
  'missing_goal',
  'no_acceptance_criteria',
  'unverifiable_criterion',
  'unbounded_scope',
  'unbounded_retry',
  'missing_input',
  'unknown_dependency',
  'dependency_cycle',
  'overlapping_scope',
  'no_non_goals',
  'no_evidence_required',
  'stale_handoff',
  'long_block',
  'interpretation_drift',
]);
export type LintRuleId = z.infer<typeof LintRuleId>;

export const LintResult = z.object({
  rule: LintRuleId,
  severity: LintSeverity,
  message: z.string(),
  task_id: z.string(),
  /** JSON-pointer-ish path into the contract, e.g. "acceptance_criteria/1/check". */
  field: z.string().optional(),
});
export type LintResult = z.infer<typeof LintResult>;

export interface LintContext {
  /** Other contracts in the same mission (excluding the one being linted). */
  siblings: TaskContract[];
  repoRoot: string;
  fileExists: (relPath: string) => boolean;
}

export interface LintRule {
  id: LintRuleId;
  severity: LintSeverity;
  check(contract: TaskContract, ctx: LintContext): LintResult[];
}

export const hasLintErrors = (results: LintResult[]): boolean => results.some((r) => r.severity === 'error');
