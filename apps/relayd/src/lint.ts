/**
 * Defensive shim over `@relay/protocol`'s `lintContract`, which is being written by the protocol agent.
 * If the export exists it is used verbatim. Otherwise a minimal fallback implements only the two
 * spawn-gating rules relayd needs (`no_acceptance_criteria`, `unverifiable_criterion`,
 * `unknown_dependency`) so the orchestrator's lint gate works before the full linter lands.
 */
import * as protocol from '@relay/protocol';
import type { LintContext, LintResult, TaskContract } from '@relay/protocol';
import fs from 'node:fs';
import path from 'node:path';

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

function containedInput(root: string, input: string): boolean {
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || input.split(/[\\/]/).includes('..')) return false;
  const contains = (base: string, file: string) => {
    const rel = path.relative(base, file);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const file = path.resolve(root, input);
  if (!contains(path.resolve(root), file)) return false;
  // Check the nearest existing ancestor too: missing dependency outputs may sit under symlinks.
  try {
    let ancestor = file;
    while (!fs.existsSync(ancestor)) {
      if (fs.lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
    // Nonexistent roots are used by the pure lint fixtures; lexical checks still apply.
    if (!fs.existsSync(root)) return true;
    return contains(fs.realpathSync(root), fs.realpathSync(ancestor));
  } catch { return false; }
}

export function lintContract(contract: TaskContract, ctx: LintContext): LintResult[] {
  const unsafe = new Set((contract.inputs ?? []).flatMap((input, i) => containedInput(ctx.repoRoot, input) ? [] : [`inputs/${i}`]));
  const results = real ? real(contract, ctx) : fallback(contract, ctx);
  return [
    ...results.filter(r => r.rule !== 'missing_input' || !unsafe.has(r.field ?? '')),
    ...[...unsafe].map((field): LintResult => ({ rule: 'missing_input', severity: 'error', task_id: contract.id, field, message: `input must stay within ${ctx.repoRoot}` })),
  ];
}
