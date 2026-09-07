import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const regularModes = new Set(['100644', '100755']);

function safePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('\\') ||
      path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || /^[A-Za-z]:/.test(file) ||
      file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error(`Integrity: unsafe relative path ${JSON.stringify(file)}`);
  }
}

/** Verify a quiescent repository; archive the returned commit, not a later HEAD. */
export function assertCommittedIntegrity(repo, expectedFiles, requiredPaths = []) {
  if (typeof repo !== 'string' || !repo || repo.includes('\0')) throw new Error('Integrity: repo must be a nonempty path string');
  if (!expectedFiles || typeof expectedFiles !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(expectedFiles))) {
    throw new Error('Integrity: expectedFiles must be a plain object of UTF-8 strings');
  }
  if (!Array.isArray(requiredPaths)) throw new Error('Integrity: requiredPaths must be an array');
  const expected = new Map();
  for (const [file, value] of Object.entries(expectedFiles)) {
    safePath(file);
    if (typeof value !== 'string') throw new Error(`Integrity: expected bytes for ${JSON.stringify(file)} must be a UTF-8 string`);
    expected.set(file, Buffer.from(value, 'utf8'));
  }
  for (const file of requiredPaths) safePath(file);
  const files = [...new Set([...expected.keys(), ...requiredPaths])];
  const git = (...args) => {
    try {
      return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', ...args], {
        cwd: repo, timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      throw new Error(`Integrity: git ${args[0]} failed: ${cause.message}`, { cause });
    }
  };
  const resolveHead = () => {
    const result = git('rev-parse', '--verify', 'HEAD^{commit}').toString('ascii');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n$/.test(result)) throw new Error('Integrity: invalid HEAD commit');
    return result.slice(0, -1);
  };
  const head = resolveHead();
  for (const file of files) {
    const label = JSON.stringify(file);
    const tree = git('ls-tree', '-z', '--full-tree', head, '--', file);
    const tab = tree.indexOf(9);
    if (tab < 0) throw new Error(`Integrity: missing committed file ${label}`);
    const [mode, type, oid] = tree.subarray(0, tab).toString('ascii').split(' ');
    if (!tree.subarray(tab + 1).equals(Buffer.from(`${file}\0`))) throw new Error(`Integrity: ambiguous committed path ${label}`);
    if (!regularModes.has(mode) || type !== 'blob') throw new Error(`Integrity: non-regular Git mode ${mode} for ${label}`);
    const bytes = git('cat-file', 'blob', oid);
    if (expected.has(file) && !bytes.equals(expected.get(file))) throw new Error(`Integrity: committed bytes mismatch for ${label}`);
    const index = git('ls-files', '--stage', '-z', '--', file);
    if (!index.equals(Buffer.from(`${mode} ${oid} 0\t${file}\0`))) throw new Error(`Integrity: dirty index for ${label}`);
    // Read disk independently of Git stat caches, clean filters, and hidden-dirty flags.
    let current = path.resolve(repo);
    const parts = file.split('/');
    for (const [i, part] of parts.entries()) {
      current = path.join(current, part);
      let stat;
      try { stat = lstatSync(current); }
      catch (cause) { throw new Error(`Integrity: missing worktree path ${label}`, { cause }); }
      if (i < parts.length - 1) {
        if (!stat.isDirectory()) throw new Error(`Integrity: non-directory worktree parent for ${label}`);
      } else {
        if (!stat.isFile()) throw new Error(`Integrity: non-regular worktree file ${label}`);
        const diskMode = stat.mode & 0o100 ? '100755' : '100644';
        if (diskMode !== mode || !readFileSync(current).equals(bytes)) throw new Error(`Integrity: dirty worktree for ${label}`);
      }
    }
  }
  if (resolveHead() !== head) throw new Error('Integrity: HEAD changed during inspection');
  return head;
}
