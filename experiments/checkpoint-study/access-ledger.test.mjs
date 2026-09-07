import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandCandidates, accessLedger } from './access-ledger.mjs';

test('parses static command arguments without executing tool input', () => {
  const input = 'await tools.exec_command({cmd:"cat docs/rules.md",workdir:"/repo"}); throw new Error("must never execute");';
  assert.deepEqual(commandCandidates(input), [{ command: 'cat docs/rules.md', workdir: '/repo', dynamic: false }]);
});

test('retains dynamic expressions as unresolved rather than guessing file accesses', () => {
  const commands = commandCandidates('await tools.exec_command({cmd: "cat " + chosenPath});');
  assert.equal(commands[0].dynamic, true);
  assert.equal(commands[0].command, null);
  assert.match(commands[0].expression, /chosenPath/);
});

test('deduplicates repeated rollout history and assigns logical step without labeling reads as waste', () => {
  const events = [{ timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'await tools.exec_command({cmd:"cat docs/rules.md"});' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'text', text: 'source bytes' }] } }];
  const rows = accessLedger([{ actor: 't-owner', events }, { actor: 't-owner', events: structuredClone(events) }], [{ type: 'step_started', step: 1, elapsed_ms: 1000 }], '2026-01-01T00:00:00Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, 1);
  assert.equal(rows[0].classification, 'unreviewed');
  assert.deepEqual(rows[0].output, [{ type: 'text', text: 'source bytes' }]);
  assert.equal(rows[0].commands[0].command, 'cat docs/rules.md');
});
