import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accountRollouts, readRollouts } from './accounting.mjs';
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
const record = (response, value, total = value) => ({ type: 'token_usage_record', payload: { thread_id: 'owner', turn_id: 'turn-1', response_id: response, usage: value, thread_token_usage: total } });
const event = type => ({ type: 'event_msg', payload: { type, turn_id: 'turn-1' } });
const counter = value => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: value } } });

test('charges all owner requests once, not repeated cumulative usage or copied rollout history', () => {
  const events = [event('task_started'), record('r1', usage(100, 60, 10)), record('r2', usage(80, 70, 5), usage(180, 130, 15)), counter(usage(180, 130, 15)), event('task_complete')];
  const result = accountRollouts([{ actor: 'owner', events }, { actor: 'owner', events }]);
  assert.equal(result.usage_complete, true);
  assert.equal(result.unique_requests, 2);
  assert.deepEqual(result.known_usage, { input_tokens: 180, cached_input_tokens: 130, uncached_input_tokens: 50, output_tokens: 15 });
});

test('requires every launched actor and a billed terminal counter for every completed turn', () => {
  const events = [event('task_started'), record('r1', usage(100, 60, 10)), counter(usage(100, 60, 10)), event('task_complete')];
  const missing = accountRollouts([{ actor: 'owner', events }], ['owner', 'child']);
  assert.equal(missing.usage_complete, false);
  assert.deepEqual(missing.incomplete_actors, ['child']);
  const later = [...events, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } }, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } }];
  assert.equal(accountRollouts([{ actor: 'owner', events: later }]).usage_complete, false);
});

test('a final output after the last cumulative counter remains incomplete', () => {
  const events = [event('task_started'), record('r1', usage(100, 60, 10)), counter(usage(100, 60, 10)),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } } }, event('task_complete')];
  assert.equal(accountRollouts([{ actor: 'owner', events }]).usage_complete, false);
});

test('retains unfinished and missing usage instead of treating them as zero cost', () => {
  const partial = accountRollouts([{ actor: 'owner', events: [event('task_started'), record('r1', usage(100, 60, 10))] }, { actor: 'child', events: [event('task_started')] }]);
  assert.equal(partial.usage_complete, false);
  assert.equal(partial.known_usage.input_tokens, 100);
  assert.deepEqual(partial.incomplete_actors, ['child', 'owner']);
});

test('detects missing request records from cumulative totals and conflicting duplicate billing', () => {
  const missing = accountRollouts([{ actor: 'owner', events: [event('task_started'), record('r2', usage(80, 70, 5), usage(180, 130, 15)), event('task_complete')] }]);
  assert.equal(missing.usage_complete, false);
  assert.match(missing.issues.join(' '), /cumulative/);
  assert.throws(() => accountRollouts([{ actor: 'owner', events: [record('same', usage(1, 0, 1)), record('same', usage(2, 0, 1))] }]), /conflicting/);
});

test('counts a failed turn as incomplete even when some request usage exists', () => {
  const result = accountRollouts([{ actor: 'owner', events: [event('task_started'), record('r1', usage(100, 60, 10)), event('turn_aborted')] }]);
  assert.equal(result.usage_complete, false);
  assert.equal(result.known_usage.input_tokens, 100);
});

for (const target of ['plugin', 'actor', 'root']) {
  test(`tolerates ${target} directory disappearing between discovery and enumeration`, t => {
    const root = fs.mkdtempSync(path.join(process.cwd(), 'experiments/checkpoint-study/.accounting-race-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const plugin = path.join(root, 'owner/plugins/cache/plugin-install-temp');
    fs.mkdirSync(plugin, { recursive: true });
    fs.mkdirSync(path.join(root, 'child'));
    const events = [event('task_started'), record('r1', usage(100, 60, 10)), counter(usage(100, 60, 10)), event('task_complete')];
    fs.writeFileSync(path.join(root, 'owner/rollout-owner.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    const disappearing = target === 'plugin' ? plugin : target === 'actor' ? path.join(root, 'child') : root;
    const readdir = fs.readdirSync;
    let raced = false;
    t.mock.method(fs, 'readdirSync', (dir, options) => {
      if (dir === disappearing && !raced) {
        raced = true;
        fs.rmSync(dir, { recursive: true });
      }
      return readdir(dir, options);
    });
    const rollouts = readRollouts(root);
    assert.equal(raced, true);
    const result = accountRollouts(rollouts, ['owner', 'child']);
    assert.equal(result.usage_complete, false);
    assert.deepEqual(result.incomplete_actors, target === 'root' ? ['child', 'owner'] : ['child']);
    assert.equal(result.known_usage.input_tokens, target === 'root' ? 0 : 100);
  });
}

test('propagates non-ENOENT enumeration errors', t => {
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readdirSync', () => { throw error; });
  assert.throws(() => readRollouts(process.cwd()), e => e === error);
});
