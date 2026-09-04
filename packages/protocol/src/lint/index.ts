/**
 * Communication-debt linter (PRD.md §11). Static rules run on `task_proposed` / `contract_revised`;
 * runtime rules run against derived `State` with a clock supplied by the caller.
 * `interpretation_drift` (LLM-based) is intentionally not implemented.
 */
import type { LintContext, LintResult, LintRule } from '../lint.js';
import type { TaskContract } from '../contract.js';
import type { State } from '../state.js';
import { result } from './util.js';

import { rule as missingGoal } from './rules/missing_goal.js';
import { rule as noAcceptanceCriteria } from './rules/no_acceptance_criteria.js';
import { rule as unverifiableCriterion } from './rules/unverifiable_criterion.js';
import { rule as unboundedScope } from './rules/unbounded_scope.js';
import { rule as unboundedRetry } from './rules/unbounded_retry.js';
import { rule as missingInput } from './rules/missing_input.js';
import { rule as unknownDependency } from './rules/unknown_dependency.js';
import { rule as dependencyCycle } from './rules/dependency_cycle.js';
import { rule as overlappingScope } from './rules/overlapping_scope.js';
import { rule as noNonGoals } from './rules/no_non_goals.js';
import { rule as noEvidenceRequired } from './rules/no_evidence_required.js';

/** Static rules in report order. Errors first, then warnings. */
export const STATIC_RULES: readonly LintRule[] = [
  missingGoal,
  noAcceptanceCriteria,
  unverifiableCriterion,
  unboundedScope,
  unboundedRetry,
  missingInput,
  unknownDependency,
  dependencyCycle,
  overlappingScope,
  noNonGoals,
  noEvidenceRequired,
];

/** Runs every static rule against one contract. Pure; file existence comes from `ctx.fileExists`. */
export function lintContract(contract: TaskContract, ctx: LintContext): LintResult[] {
  return STATIC_RULES.flatMap((rule) => rule.check(contract, ctx));
}

/** Handoffs proposed / blockers open longer than this are reported by `runtimeLint`. */
export const RUNTIME_LINT_THRESHOLD_MS = 5 * 60_000;

/** Time-based warnings derived from `State`. `now` is injected so this stays pure and replayable. */
export function runtimeLint(state: State, now: Date): LintResult[] {
  const nowMs = now.getTime();
  const out: LintResult[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.handoff_state === 'proposed' && task.proposed_at !== undefined) {
      const age = nowMs - Date.parse(task.proposed_at);
      if (age > RUNTIME_LINT_THRESHOLD_MS) {
        out.push(result('stale_handoff', 'warning', task, `handoff proposed ${Math.round(age / 60_000)} min ago without a response`));
      }
    }
    if (task.runtime === 'blocked' && task.blocker !== undefined) {
      const age = nowMs - Date.parse(task.blocker.since);
      if (age > RUNTIME_LINT_THRESHOLD_MS) {
        const waiting = task.blocker.waiting_on ? ` (waiting on ${task.blocker.waiting_on})` : '';
        out.push(result('long_block', 'warning', task, `blocked for ${Math.round(age / 60_000)} min: ${task.blocker.reason}${waiting}`));
      }
    }
  }
  return out;
}
