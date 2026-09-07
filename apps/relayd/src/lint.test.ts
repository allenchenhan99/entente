import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TaskContract } from '@relay/protocol';
import { sampleContract } from './fakes/test-harness.js';
import { lintContract } from './lint.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it('rejects traversal, absolute and symlink escapes even when they exist or match a dependency', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lint-')); dirs.push(dir);
  const root = path.join(dir, 'parent'); fs.mkdirSync(root);
  const outside = path.join(dir, 'outside.md'); fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(root, 'link.md'));
  const dependency = TaskContract.parse({ ...sampleContract('t-dep', { scope: { allowed_paths: ['**'] } }), mission_id: 'm-test', version: 1, sender: 'planner' });
  const contract = TaskContract.parse({ ...sampleContract('t-child', { inputs: ['../outside.md', outside, 'link.md'], dependencies: ['t-dep'] }), mission_id: 'm-test', version: 1, sender: 'planner' });
  const results = lintContract(contract, { siblings: [dependency], repoRoot: root, fileExists: rel => fs.existsSync(path.resolve(root, rel)) });
  expect(results.filter(r => r.rule === 'missing_input').map(r => r.field)).toEqual(['inputs/0', 'inputs/1', 'inputs/2']);
});

it('preserves missing inputs and declared dependency-produced inputs', () => {
  const contract = TaskContract.parse({ ...sampleContract('t-child', { inputs: ['missing.md', 'src/t-dep/report.md'], dependencies: ['t-dep'] }), mission_id: 'm-test', version: 1, sender: 'planner' });
  const dependency = TaskContract.parse({ ...sampleContract('t-dep'), mission_id: 'm-test', version: 1, sender: 'planner' });
  expect(lintContract(contract, { siblings: [dependency], repoRoot: '/repo', fileExists: () => false }).filter(r => r.rule === 'missing_input')).toMatchObject([{ field: 'inputs/0', severity: 'error' }]);
});
