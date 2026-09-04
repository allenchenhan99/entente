import type { LintRule } from '../../lint.js';
import { result } from '../util.js';

/** Depth-first search over self + siblings; reports the first cycle that leads back to self. */
export const rule: LintRule = {
  id: 'dependency_cycle',
  severity: 'error',
  check(contract, ctx) {
    const deps = new Map<string, string[]>();
    deps.set(contract.id, contract.dependencies ?? []);
    for (const s of ctx.siblings) if (!deps.has(s.id)) deps.set(s.id, s.dependencies ?? []);

    const visited = new Set<string>();
    const walk = (node: string, path: string[]): string[] | undefined => {
      for (const next of deps.get(node) ?? []) {
        if (next === contract.id) return [...path, next];
        if (visited.has(next)) continue;
        visited.add(next);
        const found = walk(next, [...path, next]);
        if (found) return found;
      }
      return undefined;
    };
    const cycle = walk(contract.id, [contract.id]);
    return cycle ? [result('dependency_cycle', 'error', contract, `dependency cycle: ${cycle.join(' → ')}`, 'dependencies')] : [];
  },
};
