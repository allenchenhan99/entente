import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskContract } from '@relay/protocol';
import type { WorktreeInfo, WorktreeManager } from '../ports.js';
import { defaultExec, describeFailure, type Exec, type ExecDeps, type ExecResult } from '../launch/exec.js';

export interface DiffOptions {
  patchPath?: string;
}

export type WorktreeManagerDeps = ExecDeps;

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function withTrailingNewline(text: string): string {
  return text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
}

export class GitWorktreeManager implements WorktreeManager {
  private readonly exec: Exec;

  constructor(deps: WorktreeManagerDeps = {}) {
    this.exec = deps.exec ?? defaultExec;
  }

  private async git(args: string[], cwd: string, allowedExitCodes: readonly number[] = [0]): Promise<ExecResult> {
    const argv = ['git', ...args];
    const result = await this.exec(argv, { cwd });
    if (!allowedExitCodes.includes(result.exitCode)) throw new Error(`worktree manager: ${describeFailure(argv, result)}`);
    return result;
  }

  private async ensureRelayIgnored(repoRoot: string): Promise<void> {
    const resolved = await this.git(['rev-parse', '--git-path', 'info/exclude'], repoRoot);
    const reportedPath = resolved.stdout.trim();
    if (!reportedPath) throw new Error('worktree manager: git returned no info/exclude path');
    const excludePath = path.isAbsolute(reportedPath) ? reportedPath : path.resolve(repoRoot, reportedPath);
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (lines(current).includes('.relay/')) return;
    fs.appendFileSync(excludePath, `${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}.relay/\n`);
  }

  async create(repoRoot: string, task: TaskContract, dependencyBranches: string[]): Promise<WorktreeInfo> {
    await this.ensureRelayIgnored(repoRoot);
    const worktreePath = path.join(repoRoot, '.relay', 'wt', task.id);
    const branch = `relay/${task.id}`;

    if (fs.existsSync(worktreePath)) {
      const head = await this.git(['rev-parse', 'HEAD'], worktreePath);
      return { path: worktreePath, branch, base: head.stdout.trim() };
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await this.git(['worktree', 'add', worktreePath, '-b', branch, 'HEAD'], repoRoot);
    for (const dependencyBranch of dependencyBranches) {
      await this.git(['merge', '--no-edit', dependencyBranch], worktreePath);
    }
    const head = await this.git(['rev-parse', 'HEAD'], worktreePath);
    return { path: worktreePath, branch, base: head.stdout.trim() };
  }

  async remove(repoRoot: string, taskId: string): Promise<void> {
    const worktreePath = path.join(repoRoot, '.relay', 'wt', taskId);
    await this.git(['worktree', 'remove', '--force', worktreePath], repoRoot);
    await this.git(['branch', '-D', `relay/${taskId}`], repoRoot);
  }

  async diff(worktreePath: string, base: string, options: DiffOptions = {}): Promise<{ patchPath: string; changedFiles: string[] }> {
    const trackedNames = await this.git(['diff', '--name-only', base], worktreePath);
    const untrackedNames = await this.git(['ls-files', '--others', '--exclude-standard'], worktreePath);
    const untracked = lines(untrackedNames.stdout);
    const changedFiles = [...new Set([...lines(trackedNames.stdout), ...untracked])].sort();
    const trackedPatch = await this.git(['diff', base], worktreePath);
    const patchParts = [withTrailingNewline(trackedPatch.stdout)];

    for (const file of untracked) {
      const untrackedPatch = await this.git(['diff', '--no-index', '--', '/dev/null', file], worktreePath, [0, 1]);
      patchParts.push(withTrailingNewline(untrackedPatch.stdout));
    }

    const patchPath = options.patchPath ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-diff-')), 'attempt.patch');
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.writeFileSync(patchPath, patchParts.join(''), 'utf8');
    return { patchPath, changedFiles };
  }

  async integrate(repoRoot: string, branches: string[]): Promise<{ branch: string; conflict?: { branch: string; files: string[] } }> {
    await this.ensureRelayIgnored(repoRoot);
    const branch = 'relay/integration';
    const worktreePath = path.join(repoRoot, '.relay', 'wt', 'integration');
    const repoHead = (await this.git(['rev-parse', 'HEAD'], repoRoot)).stdout.trim();

    if (fs.existsSync(worktreePath)) {
      await this.git(['reset', '--hard', repoHead], worktreePath);
      await this.git(['clean', '-fd'], worktreePath);
    } else {
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      await this.git(['worktree', 'prune'], repoRoot);
      await this.git(['worktree', 'add', worktreePath, '-B', branch, repoHead], repoRoot);
    }

    for (const mergeBranch of branches) {
      const merge = await this.git(['merge', '--no-edit', mergeBranch], worktreePath, [0, 1]);
      if (merge.exitCode === 0) continue;
      const unresolved = await this.git(['diff', '--name-only', '--diff-filter=U'], worktreePath);
      await this.git(['merge', '--abort'], worktreePath);
      return { branch, conflict: { branch: mergeBranch, files: lines(unresolved.stdout).sort() } };
    }

    return { branch };
  }
}

export function createWorktreeManager(deps: WorktreeManagerDeps = {}): GitWorktreeManager {
  return new GitWorktreeManager(deps);
}
