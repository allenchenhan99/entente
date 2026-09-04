/** In-memory WorktreeManager: records calls, never touches git. */
import type { TaskContract } from '@relay/protocol';
import type { WorktreeManager, WorktreeInfo } from '../ports.js';

export interface FakeWorktreeOptions {
  /** Make `integrate` report a conflict on this branch. */
  conflict?: { branch: string; files: string[] };
}

export interface FakeWorktrees extends WorktreeManager {
  calls: {
    create: Array<{ repoRoot: string; taskId: string; dependencyBranches: string[] }>;
    remove: string[];
    integrate: string[][];
    commitAll: Array<{ worktreePath: string; message: string }>;
  };
  options: FakeWorktreeOptions;
}

export const fakeWorktreeInfo = (taskId: string): WorktreeInfo => ({
  path: `/tmp/fake/${taskId}`,
  branch: `relay/${taskId}`,
  base: 'main',
});

export function fakeWorktrees(options: FakeWorktreeOptions = {}): FakeWorktrees {
  const calls: FakeWorktrees['calls'] = { create: [], remove: [], integrate: [], commitAll: [] };
  return {
    calls,
    options,
    async create(repoRoot: string, task: TaskContract, dependencyBranches: string[]) {
      calls.create.push({ repoRoot, taskId: task.id, dependencyBranches: [...dependencyBranches] });
      return fakeWorktreeInfo(task.id);
    },
    async remove(_repoRoot: string, taskId: string) {
      calls.remove.push(taskId);
    },
    async diff(worktreePath: string) {
      return { patchPath: `${worktreePath}.patch`, changedFiles: [] };
    },
    async commitAll(worktreePath: string, message: string) {
      calls.commitAll.push({ worktreePath, message });
      return { committed: true, sha: 'fake-sha' };
    },
    async integrate(_repoRoot: string, branches: string[]) {
      calls.integrate.push([...branches]);
      const c = this.options.conflict;
      if (c && branches.includes(c.branch)) return { branch: 'relay/integration', conflict: { branch: c.branch, files: [...c.files] } };
      return { branch: 'relay/integration' };
    },
  };
}
