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

function nulSeparated(text: string): string[] {
  return text.length === 0 ? [] : text.split('\0').filter((value) => value.length > 0);
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

  private async ignoreGitFailure(args: string[], cwd: string): Promise<void> {
    try {
      await this.exec(['git', ...args], { cwd });
    } catch {
      // Preserve the original create error; cleanup is best-effort.
    }
  }

  private basePath(repoRoot: string, taskId: string): string {
    return path.join(repoRoot, '.relay', 'wt', '.bases', encodeURIComponent(taskId));
  }

  private readBase(repoRoot: string, taskId: string): string {
    const basePath = this.basePath(repoRoot, taskId);
    if (!fs.existsSync(basePath)) throw new Error(`worktree manager: existing worktree for ${taskId} has no recorded base`);
    const base = fs.readFileSync(basePath, 'utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`worktree manager: invalid recorded base for ${taskId}`);
    return base;
  }

  private writeBase(repoRoot: string, taskId: string, base: string): void {
    const basePath = this.basePath(repoRoot, taskId);
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, `${base}\n`, 'utf8');
  }

  private async ensureRelayIgnored(repoRoot: string): Promise<void> {
    const resolved = await this.git(['rev-parse', '--git-path', 'info/exclude'], repoRoot);
    const reportedPath = resolved.stdout.trim();
    if (!reportedPath) throw new Error('worktree manager: git returned no info/exclude path');
    const excludePath = path.isAbsolute(reportedPath) ? reportedPath : path.resolve(repoRoot, reportedPath);
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    // `.relay/` holds worktrees and evidence; `node_modules` may be a symlink relayd itself creates (see linkNodeModules).
    const missing = ['.relay/', 'node_modules'].filter((entry) => !lines(current).includes(entry));
    if (missing.length === 0) return;
    fs.appendFileSync(excludePath, `${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }

  /**
   * A fresh worktree has no installed dependencies, so `command` checks like `npx vitest` would fail before
   * the agent wrote a line. Share the repository's `node_modules` via symlink (ignored by git) when present.
   */
  private linkNodeModules(repoRoot: string, worktreePath: string): void {
    const source = path.join(repoRoot, 'node_modules');
    const target = path.join(worktreePath, 'node_modules');
    if (!fs.existsSync(source) || fs.existsSync(target)) return;
    fs.symlinkSync(source, target, 'dir');
  }

  async create(repoRoot: string, task: TaskContract, dependencyBranches: string[]): Promise<WorktreeInfo> {
    await this.ensureRelayIgnored(repoRoot);
    const worktreePath = path.join(repoRoot, '.relay', 'wt', task.id);
    const branch = `relay/${task.id}`;

    if (fs.existsSync(worktreePath)) {
      const currentBranch = (await this.git(['branch', '--show-current'], worktreePath)).stdout.trim();
      if (currentBranch !== branch) {
        throw new Error(`worktree manager: ${worktreePath} is on ${currentBranch || 'detached HEAD'}, expected ${branch}`);
      }
      this.linkNodeModules(repoRoot, worktreePath);
      return { path: worktreePath, branch, base: this.readBase(repoRoot, task.id) };
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    let worktreeAdded = false;
    try {
      await this.git(['worktree', 'add', worktreePath, '-b', branch, 'HEAD'], repoRoot);
      worktreeAdded = true;
      for (const dependencyBranch of dependencyBranches) {
        await this.git(['merge', '--no-edit', dependencyBranch], worktreePath);
      }
      const head = await this.git(['rev-parse', 'HEAD'], worktreePath);
      const base = head.stdout.trim();
      this.writeBase(repoRoot, task.id, base);
      this.linkNodeModules(repoRoot, worktreePath);
      return { path: worktreePath, branch, base };
    } catch (error) {
      if (worktreeAdded) {
        await this.ignoreGitFailure(['merge', '--abort'], worktreePath);
        await this.ignoreGitFailure(['worktree', 'remove', '--force', worktreePath], repoRoot);
        await this.ignoreGitFailure(['branch', '-D', branch], repoRoot);
      }
      fs.rmSync(this.basePath(repoRoot, task.id), { force: true });
      throw error;
    }
  }

  async mergeBranch(worktreePath: string, branch: string): Promise<{ merged: boolean; conflict?: string[] }> {
    const merge = await this.git(['-c', 'user.name=relayd', '-c', 'user.email=relayd@localhost', 'merge', '--no-edit', branch], worktreePath, [0, 1]);
    if (merge.exitCode === 0) return { merged: true };
    const unresolved = await this.git(['diff', '--name-only', '--diff-filter=U', '-z'], worktreePath);
    await this.ignoreGitFailure(['merge', '--abort'], worktreePath);
    return { merged: false, conflict: nulSeparated(unresolved.stdout).sort() };
  }

  async commitAll(worktreePath: string, message: string): Promise<{ committed: boolean; sha?: string }> {
    await this.git(['add', '-A'], worktreePath);
    const status = await this.git(['status', '--porcelain'], worktreePath);
    if (status.stdout.trim() === '') return { committed: false };
    await this.git(['-c', 'user.name=relayd', '-c', 'user.email=relayd@localhost', 'commit', '-q', '-m', message], worktreePath);
    const head = await this.git(['rev-parse', 'HEAD'], worktreePath);
    return { committed: true, sha: head.stdout.trim() };
  }

  async remove(repoRoot: string, taskId: string): Promise<void> {
    const worktreePath = path.join(repoRoot, '.relay', 'wt', taskId);
    await this.git(['worktree', 'remove', '--force', worktreePath], repoRoot);
    await this.git(['branch', '-D', `relay/${taskId}`], repoRoot);
    fs.rmSync(this.basePath(repoRoot, taskId), { force: true });
  }

  async diff(worktreePath: string, base: string, options: DiffOptions = {}): Promise<{ patchPath: string; changedFiles: string[] }> {
    const trackedNames = await this.git(['diff', '--name-only', '-z', base], worktreePath);
    const untrackedNames = await this.git(['ls-files', '--others', '--exclude-standard', '-z'], worktreePath);
    const untracked = nulSeparated(untrackedNames.stdout);
    const changedFiles = [...new Set([...nulSeparated(trackedNames.stdout), ...untracked])].sort();
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
      const unresolved = await this.git(['diff', '--name-only', '--diff-filter=U', '-z'], worktreePath);
      await this.git(['merge', '--abort'], worktreePath);
      return { branch, conflict: { branch: mergeBranch, files: nulSeparated(unresolved.stdout).sort() } };
    }

    return { branch };
  }
}

export function createWorktreeManager(deps: WorktreeManagerDeps = {}): GitWorktreeManager {
  return new GitWorktreeManager(deps);
}
