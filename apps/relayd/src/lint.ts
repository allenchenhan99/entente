/**
 * Defensive shim over `@relay/protocol`'s `lintContract`, which is being written by the protocol agent.
 * If the export exists it is used verbatim. Otherwise a minimal fallback implements only the two
 * spawn-gating rules relayd needs (`no_acceptance_criteria`, `unverifiable_criterion`,
 * `unknown_dependency`) so the orchestrator's lint gate works before the full linter lands.
 */
import * as protocol from '@relay/protocol';
import type { LintContext, LintResult, TaskContract } from '@relay/protocol';

type LintFn = (contract: TaskContract, ctx: LintContext) => LintResult[];

const real: LintFn | undefined =
  typeof (protocol as Record<string, unknown>).lintContract === 'function'
    ? ((protocol as Record<string, unknown>).lintContract as LintFn)
    : undefined;

function fallback(contract: TaskContract, ctx: LintContext): LintResult[] {
  const out: LintResult[] = [];
  const known = new Set([contract.id, ...ctx.siblings.map((s) => s.id)]);
  contract.dependencies.forEach((dep, i) => {
    if (!known.has(dep)) {
      out.push({
        rule: 'unknown_dependency',
        severity: 'error',
        message: `dependency "${dep}" is not a task in this mission`,
        task_id: contract.id,
        field: `dependencies/${i}`,
      });
    }
  });
  if (contract.acceptance_criteria.length === 0) {
    out.push({
      rule: 'no_acceptance_criteria',
      severity: 'error',
      message: 'contract has no acceptance criteria',
      task_id: contract.id,
      field: 'acceptance_criteria',
    });
  }
  contract.acceptance_criteria.forEach((ac, i) => {
    if (!ac.check) {
      out.push({
        rule: 'unverifiable_criterion',
        severity: 'error',
        message: `${ac.id} has no check`,
        task_id: contract.id,
        field: `acceptance_criteria/${i}/check`,
      });
    }
  });
  return out;
}

export const usingFallbackLint = real === undefined;

export function lintContract(contract: TaskContract, ctx: LintContext): LintResult[] {
  return real ? real(contract, ctx) : fallback(contract, ctx);
}
