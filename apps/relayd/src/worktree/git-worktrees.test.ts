import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskContract, type TaskContract as TaskContractType } from '@relay/protocol';
import { createWorktreeManager } from './git-worktrees.js';

const tempRepos: string[] = [];

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo: string, file: string, content: string): void {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function createRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  tempRepos.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Relay Test']);
  git(repo, ['config', 'user.email', 'relay@example.test']);
  write(repo, 'tracked.txt', 'original\n');
  write(repo, 'deleted.txt', 'remove me\n');
  write(repo, 'shared.txt', 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

function task(id = 't-worktree'): TaskContractType {
  return TaskContract.parse({
    id,
    mission_id: 'm-test',
    version: 1,
    sender: 'planner',
    recipient: 'verify',
    runtime: 'codex',
    goal: 'Exercise the worktree manager',
  });
}

function createBranch(repo: string, branch: string, changes: Record<string, string>): void {
  git(repo, ['switch', '-c', branch]);
  for (const [file, content] of Object.entries(changes)) write(repo, file, content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', branch]);
  git(repo, ['switch', 'main']);
}

afterEach(() => {
  for (const repo of tempRepos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
});

describe('git worktree manager', () => {
  it('worktree creates with dependency branches, records its base, ignores relay state, and removes cleanly', async () => {
    const repo = createRepo();
    createBranch(repo, 'relay/dependency', { 'dep.txt': 'dependency content\n' });
    const manager = createWorktreeManager();

    const first = await manager.create(repo, task(), ['relay/dependency']);
    write(first.path, 'task-change.txt', 'agent work\n');
    git(first.path, ['add', 'task-change.txt']);
    git(first.path, ['commit', '-m', 'agent work']);
    const taskHead = git(first.path, ['rev-parse', 'HEAD']);
    const second = await createWorktreeManager().create(repo, task(), ['relay/dependency']);

    expect(second).toEqual(first);
    expect(taskHead).not.toBe(first.base);
    expect(first.path).toBe(path.join(repo, '.relay', 'wt', 't-worktree'));
    expect(first.branch).toBe('relay/t-worktree');
    expect(first.base).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.readFileSync(path.join(first.path, 'dep.txt'), 'utf8')).toBe('dependency content\n');
    expect(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/)).toContain('.relay/');

    await manager.remove(repo, 't-worktree');

    expect(fs.existsSync(first.path)).toBe(false);
    expect(git(repo, ['branch', '--list', 'relay/t-worktree'])).toBe('');
  });

  it('links the repository node_modules into a new worktree so command checks can run', async () => {
    const repoRoot = createRepo();
    fs.mkdirSync(path.join(repoRoot, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    const manager = createWorktreeManager();
    const info = await manager.create(repoRoot, task('t-nm'), []);
    const link = path.join(info.path, 'node_modules');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(link, 'left-pad', 'index.js'))).toBe(true);
    expect((await manager.diff(info.path, info.base)).changedFiles).toEqual([]);
  });

  it('diff reports modified, untracked, and deleted files and patches untracked content', async () => {
    const repo = createRepo();
    const manager = createWorktreeManager();
    const worktree = await manager.create(repo, task('t-diff'), []);
    write(worktree.path, 'tracked.txt', 'modified\n');
    write(worktree.path, 'untracked.txt', 'brand new content\nsecond line\n');
    write(worktree.path, '驗證.txt', 'unicode content\n');
    fs.unlinkSync(path.join(worktree.path, 'deleted.txt'));
    const patchPath = path.join(repo, '.relay', 'evidence', 't-diff', 'attempt-1.patch');

    const result = await manager.diff(worktree.path, worktree.base, { patchPath });

    expect(result.patchPath).toBe(patchPath);
    expect(result.changedFiles).toEqual(['deleted.txt', 'tracked.txt', 'untracked.txt', '驗證.txt']);
    const patch = fs.readFileSync(patchPath, 'utf8');
    expect(patch).toContain('-original');
    expect(patch).toContain('+modified');
    expect(patch).toContain('-remove me');
    expect(patch).toContain('--- /dev/null');
    expect(patch).toContain('+brand new content');
    expect(patch).toContain('+second line');
    expect(patch).toContain('+unicode content');
  });

  it('worktree cleans a failed dependency merge so a retry cannot report a conflicted checkout as ready', async () => {
    const repo = createRepo();
    createBranch(repo, 'relay/conflicting-dependency', { 'shared.txt': 'dependency version\n' });
    write(repo, 'shared.txt', 'main version\n');
    git(repo, ['add', 'shared.txt']);
    git(repo, ['commit', '-m', 'main conflict']);
    const manager = createWorktreeManager();
    const worktreePath = path.join(repo, '.relay', 'wt', 't-conflicted-create');

    await expect(manager.create(repo, task('t-conflicted-create'), ['relay/conflicting-dependency'])).rejects.toThrow(/merge/);

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(repo, ['branch', '--list', 'relay/t-conflicted-create'])).toBe('');
    await expect(manager.create(repo, task('t-conflicted-create'), ['relay/conflicting-dependency'])).rejects.toThrow(/merge/);
  });

  it('mergeBranch lands another branch in a worktree and reports conflicts without leaving the merge open', async () => {
    const repo = createRepo();
    createBranch(repo, 'relay/t-child', { 'src/child.txt': 'child\n' });
    createBranch(repo, 'relay/t-conflict', { 'README.md': 'conflicting\n' });
    const manager = createWorktreeManager();
    const parent = await manager.create(repo, task('t-parent'), []);
    fs.appendFileSync(path.join(parent.path, 'README.md'), 'parent change\n');
    await manager.commitAll(parent.path, 'parent work');
    expect(await manager.mergeBranch(parent.path, 'relay/t-child')).toEqual({ merged: true });
    expect(fs.existsSync(path.join(parent.path, 'src', 'child.txt'))).toBe(true);
    const conflict = await manager.mergeBranch(parent.path, 'relay/t-conflict');
    expect(conflict.merged).toBe(false);
    expect(conflict.conflict).toEqual(['README.md']);
    expect(git(repo, ['-C', parent.path, 'status', '--porcelain']).trim()).toBe('');
  });

  it('commitAll freezes tracked and untracked changes into the task branch so integrate merges them', async () => {
    const repo = createRepo();
    const manager = createWorktreeManager();
    const info = await manager.create(repo, task('t-commit'), []);
    fs.mkdirSync(path.join(info.path, 'public'), { recursive: true });
    fs.writeFileSync(path.join(info.path, 'public', 'login.html'), '<form></form>\n');
    fs.appendFileSync(path.join(info.path, 'README.md'), 'changed\n');

    const first = await manager.commitAll(info.path, 'relay: verified evidence attempt 1 for t-commit');
    expect(first.committed).toBe(true);
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
    expect(git(repo, ['log', '-1', '--format=%s', 'relay/t-commit'])).toBe('relay: verified evidence attempt 1 for t-commit');

    const again = await manager.commitAll(info.path, 'nothing');
    expect(again).toEqual({ committed: false });

    const integrated = await manager.integrate(repo, ['relay/t-commit']);
    expect(integrated.conflict).toBeUndefined();
    expect(git(repo, ['ls-tree', '-r', '--name-only', 'relay/integration'])).toContain('public/login.html');
  });

  it('integrate merges branches in order and aborts a conflicting merge into a clean worktree', async () => {
    const repo = createRepo();
    createBranch(repo, 'relay/one', { 'one.txt': 'one\n', 'shared.txt': 'from one\n' });
    createBranch(repo, 'relay/two', { 'two.txt': 'two\n' });
    createBranch(repo, 'relay/conflict', { 'shared.txt': 'from conflict\n' });
    const manager = createWorktreeManager();

    const integrated = await manager.integrate(repo, ['relay/one', 'relay/two']);

    const integrationPath = path.join(repo, '.relay', 'wt', 'integration');
    expect(integrated).toEqual({ branch: 'relay/integration' });
    expect(fs.readFileSync(path.join(integrationPath, 'one.txt'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(integrationPath, 'two.txt'), 'utf8')).toBe('two\n');

    const conflicted = await manager.integrate(repo, ['relay/one', 'relay/two', 'relay/conflict']);

    expect(conflicted).toEqual({
      branch: 'relay/integration',
      conflict: { branch: 'relay/conflict', files: ['shared.txt'] },
    });
    expect(git(integrationPath, ['status', '--porcelain'])).toBe('');
  });
});
