import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCommittedIntegrity } from './integrity.mjs';

const source = '  exact UTF-8: 台灣\r\n\0trailing space \n\n';
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-integrity-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), bytes);
  };
  const commit = () => {
    git('add', '--all');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD').trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Integrity Test');
  git('config', 'user.email', 'integrity@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.filemode', 'true');
  write('src/input.txt', source);
  write('out/result with spaces.mjs', 'export default 1;\n');
  const head = commit();
  const check = (expected = { 'src/input.txt': source }, required = ['out/result with spaces.mjs']) =>
    assertCommittedIntegrity(repo, expected, required);
  return { repo, git, write, commit, head, check };
}

test('clean committed exact bytes and spaced output return the inspected SHA', t => {
  const f = fixture(t);
  assert.equal(f.check(), f.head);
  assert.equal(assertCommittedIntegrity(f.repo, { 'src/input.txt': source }), f.head);
  f.write('unrelated-untracked.txt', 'unrelated');
  assert.equal(f.check(), f.head);
});

test('committed bad source restored only on disk is rejected', t => {
  const f = fixture(t);
  f.write('src/input.txt', 'bad committed source');
  f.commit();
  f.write('src/input.txt', source);
  assert.throws(() => f.check(), /committed bytes mismatch.*input/);
});

for (const staged of [false, true]) test(`${staged ? 'staged' : 'unstaged'} relevant edits are rejected`, t => {
  const f = fixture(t);
  f.write('src/input.txt', source + 'edit');
  if (staged) {
    f.git('add', 'src/input.txt');
    f.write('src/input.txt', source); // Index alone is dirty.
  }
  assert.throws(() => f.check(), staged ? /dirty index/ : /dirty worktree/);
});

for (const state of ['missing', 'untracked', 'staged']) test(`${state} required output must be committed`, t => {
  const f = fixture(t);
  const file = 'new output.mjs';
  if (state !== 'missing') f.write(file, 'output');
  if (state === 'staged') f.git('add', file);
  assert.throws(() => f.check({}, [file]), /missing committed file.*new output/);
});

test('committed symlink is rejected even when its target has expected bytes', t => {
  const f = fixture(t);
  fs.symlinkSync('src/input.txt', path.join(f.repo, 'link'));
  f.commit();
  assert.throws(() => f.check({}, ['link']), /non-regular Git mode 120000/);
});

test('submodule and directory Git modes are rejected', t => {
  const f = fixture(t);
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.head},module`);
  f.git('commit', '-qm', 'gitlink');
  assert.throws(() => f.check({}, ['module']), /non-regular Git mode 160000/);
  assert.throws(() => f.check({}, ['src']), /non-regular Git mode 040000/);
});

test('a committed mutation of a previous output is rejected', t => {
  const f = fixture(t);
  f.write('out/result with spaces.mjs', 'export default 2;\n');
  f.commit();
  assert.throws(() => f.check({ 'out/result with spaces.mjs': 'export default 1;\n' }), /committed bytes mismatch/);
});

test('whitespace and invalid UTF-8 bytes are compared exactly', t => {
  const f = fixture(t);
  assert.throws(() => f.check({ 'src/input.txt': source.trim() }), /committed bytes mismatch/);
  f.write('invalid.txt', Buffer.from([0xff]));
  f.commit();
  assert.throws(() => f.check({ 'invalid.txt': '\ufffd' }), /committed bytes mismatch/);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`disk inspection catches ${flag} mutations`, t => {
  const f = fixture(t);
  f.git('update-index', flag, 'src/input.txt');
  f.write('src/input.txt', 'hidden mutation');
  assert.throws(() => f.check(), /dirty worktree/);
});

test('worktree deletion, symlink replacement, parent symlink and mode changes fail', t => {
  const f = fixture(t);
  const file = path.join(f.repo, 'src/input.txt');
  fs.unlinkSync(file);
  assert.throws(() => f.check(), /missing worktree/);
  fs.symlinkSync('../out/result with spaces.mjs', file);
  assert.throws(() => f.check(), /non-regular worktree/);
  fs.unlinkSync(file);
  f.write('src/input.txt', source);
  fs.chmodSync(file, 0o755);
  assert.throws(() => f.check(), /dirty worktree/);
  fs.renameSync(path.join(f.repo, 'src'), path.join(f.repo, 'moved'));
  fs.symlinkSync('moved', path.join(f.repo, 'src'));
  assert.throws(() => f.check(), /non-directory worktree parent/);
});

test('committed executable mode and literal unusual names work', t => {
  const f = fixture(t);
  const files = ['script.sh', '-option', ':(glob)*', 'file[1]', 'tab\tand\nnewline'];
  for (const file of files) f.write(file, 'exact\n');
  fs.chmodSync(path.join(f.repo, 'script.sh'), 0o755);
  const head = f.commit();
  assert.equal(f.check(Object.fromEntries(files.map(file => [file, 'exact\n'])), files), head);
});

test('unsafe paths fail in both inputs before Git is invoked', () => {
  const unsafe = ['', '..', '../file', 'a/../b', './file', '/absolute', 'C:\\file', 'C:file', 'a\\b', 'a//b', 'a/', '.git/config', 'A/.GIT/config', 'bad\0path'];
  for (const file of unsafe) {
    assert.throws(() => assertCommittedIntegrity('/no-such-repo', { [file]: '' }), /unsafe relative path/);
    assert.throws(() => assertCommittedIntegrity('/no-such-repo', {}, [file]), /unsafe relative path/);
  }
});

test('invalid API inputs and absent HEAD give descriptive errors', t => {
  const f = fixture(t);
  for (const input of [null, [], new Map(), 'text', 5]) assert.throws(() => f.check(input), /expectedFiles/);
  for (const value of [null, 1, Buffer.from('bytes')]) assert.throws(() => f.check({ file: value }), /UTF-8 string/);
  assert.throws(() => f.check({}, 'file'), /requiredPaths/);
  assert.throws(() => f.check({}, [null]), /unsafe relative path/);
  assert.throws(() => assertCommittedIntegrity('', {}), /repo must/);
  const empty = path.join(f.repo, 'empty');
  fs.mkdirSync(empty);
  execFileSync('git', ['init', '-q', empty], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  assert.throws(() => assertCommittedIntegrity(empty, {}), /git rev-parse failed/);
});
