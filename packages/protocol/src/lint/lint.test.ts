import { describe, it, expect } from 'vitest';
import { lintContract, runtimeLint, STATIC_RULES } from './index.js';
import type { LintContext, LintRule, LintRuleId } from '../lint.js';
import { hasLintErrors } from '../lint.js';
import type { TaskContract } from '../contract.js';
import { contract, EventLog, MISSION_ID } from '../testkit.test.js';
import { replay } from '../reducer.js';

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

const ctx = (overrides: Partial<LintContext> = {}): LintContext => ({
  siblings: [],
  repoRoot: '/repo',
  fileExists: () => true,
  ...overrides,
});

const ids = (results: { rule: string }[]) => results.map((r) => r.rule);

describe('lint', () => {
  describe('lintContract', () => {
    it('returns [] for a fully specified contract', () => {
      expect(lintContract(contract(), ctx())).toEqual([]);
    });

    it('reports missing_goal, no_acceptance_criteria, unbounded_scope and unbounded_retry for an empty contract', () => {
      const results = lintContract({ goal: '', acceptance_criteria: [] } as unknown as TaskContract, ctx());
      expect(hasLintErrors(results)).toBe(true);
      expect(ids(results)).toEqual(expect.arrayContaining(['missing_goal', 'no_acceptance_criteria', 'unbounded_scope', 'unbounded_retry']));
      for (const r of results) expect(r.severity === 'error' || r.severity === 'warning').toBe(true);
    });

    it('runs every static rule exactly once, in a stable order, and never the runtime/LLM ones', () => {
      const staticIds: LintRuleId[] = [
        'missing_goal', 'no_acceptance_criteria', 'unverifiable_criterion', 'unbounded_scope', 'unbounded_retry',
        'missing_input', 'unknown_dependency', 'dependency_cycle', 'overlapping_scope', 'no_non_goals', 'no_evidence_required',
      ];
      expect(STATIC_RULES.map((r: LintRule) => r.id)).toEqual(staticIds);
    });

    it('stamps task_id on every result', () => {
      const results = lintContract(contract({ goal: 'x', non_goals: [] }), ctx());
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(r.task_id).toBe('t-backend-auth');
    });
  });

  describe('rule missing_goal', () => {
    it('flags a goal shorter than 8 characters after trimming', () => {
      expect(missingGoal.check(contract({ goal: '  short ' }), ctx())).toMatchObject([{ rule: 'missing_goal', severity: 'error', field: 'goal' }]);
    });
    it('accepts a goal of 8+ characters', () => {
      expect(missingGoal.check(contract({ goal: 'Add auth' }), ctx())).toEqual([]);
    });
  });

  describe('rule no_acceptance_criteria', () => {
    it('flags an empty acceptance_criteria list', () => {
      expect(noAcceptanceCriteria.check(contract({ acceptance_criteria: [] }), ctx())).toMatchObject([{ rule: 'no_acceptance_criteria', severity: 'error', field: 'acceptance_criteria' }]);
    });
    it('accepts a contract with at least one criterion', () => {
      expect(noAcceptanceCriteria.check(contract(), ctx())).toEqual([]);
    });
  });

  describe('rule unverifiable_criterion', () => {
    it('flags each criterion without a check, naming its index', () => {
      const c = contract({ acceptance_criteria: [
        { id: 'AC-1', condition: 'a', check: { kind: 'diff_scope' } },
        { id: 'AC-2', condition: 'b' },
        { id: 'AC-3', condition: 'c' },
      ] });
      expect(unverifiableCriterion.check(c, ctx())).toMatchObject([
        { rule: 'unverifiable_criterion', severity: 'error', field: 'acceptance_criteria/1/check' },
        { rule: 'unverifiable_criterion', severity: 'error', field: 'acceptance_criteria/2/check' },
      ]);
    });
    it('accepts criteria that all have checks', () => {
      expect(unverifiableCriterion.check(contract(), ctx())).toEqual([]);
    });
  });

  describe('rule unbounded_scope', () => {
    it('flags empty allowed_paths', () => {
      expect(unboundedScope.check(contract({ scope: { allowed_paths: [] } }), ctx())).toMatchObject([{ rule: 'unbounded_scope', severity: 'error', field: 'scope/allowed_paths' }]);
    });
    it('accepts a non-empty allowed_paths', () => {
      expect(unboundedScope.check(contract(), ctx())).toEqual([]);
    });
  });

  describe('rule unbounded_retry', () => {
    it('flags an undefined budget', () => {
      expect(unboundedRetry.check(contract({ budget: undefined }), ctx())).toMatchObject([{ rule: 'unbounded_retry', severity: 'error', field: 'budget' }]);
    });
    it('accepts a contract with a budget (even max_repairs 0)', () => {
      expect(unboundedRetry.check(contract({ budget: { max_repairs: 0, stagnation_limit: 2 } }), ctx())).toEqual([]);
    });
  });

  describe('rule missing_input', () => {
    it('flags inputs that ctx.fileExists rejects, naming the index', () => {
      const c = contract({ inputs: ['docs/exists.md', 'docs/missing.md'] });
      const results = missingInput.check(c, ctx({ fileExists: (p) => p === 'docs/exists.md' }));
      expect(results).toMatchObject([{ rule: 'missing_input', severity: 'error', field: 'inputs/1' }]);
      expect(results[0]!.message).toContain('docs/missing.md');
    });
    it('accepts inputs that all exist', () => {
      expect(missingInput.check(contract({ inputs: ['a', 'b'] }), ctx())).toEqual([]);
    });
  });

  describe('rule unknown_dependency', () => {
    it('flags a dependency that is neither a sibling nor self', () => {
      const c = contract({ dependencies: ['t-ghost'] });
      expect(unknownDependency.check(c, ctx({ siblings: [contract({ id: 't-frontend-login' })] }))).toMatchObject([{ rule: 'unknown_dependency', severity: 'error', field: 'dependencies/0' }]);
    });
    it('accepts dependencies on siblings', () => {
      const c = contract({ dependencies: ['t-frontend-login'] });
      expect(unknownDependency.check(c, ctx({ siblings: [contract({ id: 't-frontend-login' })] }))).toEqual([]);
    });
  });

  describe('rule dependency_cycle', () => {
    it('flags a cycle through siblings back to self', () => {
      const a = contract({ id: 't-a', dependencies: ['t-b'] });
      const b = contract({ id: 't-b', dependencies: ['t-c'] });
      const c = contract({ id: 't-c', dependencies: ['t-a'] });
      const results = dependencyCycle.check(a, ctx({ siblings: [b, c] }));
      expect(results).toMatchObject([{ rule: 'dependency_cycle', severity: 'error', field: 'dependencies' }]);
      expect(results[0]!.message).toContain('t-a → t-b → t-c → t-a');
    });
    it('flags a self-dependency', () => {
      expect(dependencyCycle.check(contract({ id: 't-a', dependencies: ['t-a'] }), ctx())).toHaveLength(1);
    });
    it('accepts an acyclic dependency chain', () => {
      const a = contract({ id: 't-a', dependencies: ['t-b'] });
      const b = contract({ id: 't-b', dependencies: ['t-c'] });
      const c = contract({ id: 't-c', dependencies: [] });
      expect(dependencyCycle.check(a, ctx({ siblings: [b, c] }))).toEqual([]);
    });
  });

  describe('rule overlapping_scope', () => {
    it('flags a path equal to a sibling path', () => {
      const self = contract({ scope: { allowed_paths: ['src/routes/auth.ts'] } });
      const sib = contract({ id: 't-frontend-login', scope: { allowed_paths: ['src/routes/auth.ts'] } });
      const results = overlappingScope.check(self, ctx({ siblings: [sib] }));
      expect(results).toMatchObject([{ rule: 'overlapping_scope', severity: 'warning', field: 'scope/allowed_paths/0' }]);
      expect(results[0]!.message).toContain('t-frontend-login');
    });
    it('flags a glob that is a prefix-ancestor of a sibling path (after stripping /** and /*)', () => {
      const self = contract({ scope: { allowed_paths: ['src/**'] } });
      const sib = contract({ id: 't-frontend-login', scope: { allowed_paths: ['src/ui/*'] } });
      expect(overlappingScope.check(self, ctx({ siblings: [sib] }))).toHaveLength(1);
    });
    it('flags a sibling glob that is a prefix-ancestor of self (overlap is symmetric)', () => {
      const self = contract({ scope: { allowed_paths: ['src/ui/login/**'] } });
      const sib = contract({ id: 't-frontend-login', scope: { allowed_paths: ['src/ui/**'] } });
      expect(overlappingScope.check(self, ctx({ siblings: [sib] }))).toHaveLength(1);
    });
    it('accepts disjoint scopes, including sibling names that merely share a string prefix', () => {
      const self = contract({ scope: { allowed_paths: ['src/auth/**', 'src/a.ts'] } });
      const sib = contract({ id: 't-frontend-login', scope: { allowed_paths: ['src/authz/**', 'src/a.ts.bak', 'tests/ui/**'] } });
      expect(overlappingScope.check(self, ctx({ siblings: [sib] }))).toEqual([]);
    });
  });

  describe('rule no_non_goals', () => {
    it('warns when non_goals is empty', () => {
      expect(noNonGoals.check(contract({ non_goals: [] }), ctx())).toMatchObject([{ rule: 'no_non_goals', severity: 'warning', field: 'non_goals' }]);
    });
    it('accepts a contract with non_goals', () => {
      expect(noNonGoals.check(contract(), ctx())).toEqual([]);
    });
  });

  describe('rule no_evidence_required', () => {
    it('warns when output.evidence_required is empty', () => {
      expect(noEvidenceRequired.check(contract({ output: { type: 'code_change', evidence_required: [] } }), ctx())).toMatchObject([{ rule: 'no_evidence_required', severity: 'warning', field: 'output/evidence_required' }]);
    });
    it('accepts a contract that requires evidence', () => {
      expect(noEvidenceRequired.check(contract(), ctx())).toEqual([]);
    });
  });

  describe('runtimeLint', () => {
    const BACKEND = 't-backend-auth';
    const t0 = Date.parse('2026-09-05T02:00:30Z'); // ts of the first event built by EventLog

    it('warns stale_handoff when a handoff has been proposed for more than 5 minutes', () => {
      const log = new EventLog();
      log.add('mission_created', { id: MISSION_ID, repo: '/r', title: 'T' }, { actor: 'human' });
      const proposed = log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
      const state = replay(log.events);
      const proposedAt = Date.parse(proposed.ts);
      expect(runtimeLint(state, new Date(proposedAt + 5 * 60_000))).toEqual([]);
      expect(runtimeLint(state, new Date(proposedAt + 5 * 60_000 + 1))).toMatchObject([{ rule: 'stale_handoff', severity: 'warning', task_id: BACKEND }]);
    });

    it('does not warn stale_handoff once the handoff is accepted', () => {
      const log = new EventLog();
      log.add('mission_created', { id: MISSION_ID, repo: '/r', title: 'T' }, { actor: 'human' });
      log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
      log.add('task_accepted', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'accepted' } }, { task_id: BACKEND, actor: 'agent:backend' });
      expect(runtimeLint(replay(log.events), new Date(t0 + 60 * 60_000))).toEqual([]);
    });

    it('warns long_block when a blocker is older than 5 minutes and clears after task_unblocked', () => {
      const log = new EventLog();
      log.add('mission_created', { id: MISSION_ID, repo: '/r', title: 'T' }, { actor: 'human' });
      log.add('task_proposed', { contract: contract() }, { task_id: BACKEND, actor: 'planner' });
      log.add('task_accepted', { contract_version: 1, response: { task_id: BACKEND, contract_version: 1, decision: 'accepted' } }, { task_id: BACKEND, actor: 'agent:backend' });
      log.add('work_started', {}, { task_id: BACKEND, actor: 'agent:backend' });
      const blocked = log.add('task_blocked', { reason: 'waiting on schema' }, { task_id: BACKEND, actor: 'agent:backend' });
      const since = Date.parse(blocked.ts);
      const state = replay(log.events);
      expect(runtimeLint(state, new Date(since + 4 * 60_000))).toEqual([]);
      const results = runtimeLint(state, new Date(since + 6 * 60_000));
      expect(results).toMatchObject([{ rule: 'long_block', severity: 'warning', task_id: BACKEND }]);
      expect(results[0]!.message).toContain('waiting on schema');
      log.add('task_unblocked', {}, { task_id: BACKEND, actor: 'human' });
      expect(runtimeLint(replay(log.events), new Date(since + 60 * 60_000))).toEqual([]);
    });
  });
});
