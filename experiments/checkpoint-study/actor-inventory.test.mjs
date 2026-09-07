import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorInventory } from './actor-inventory.mjs';
import { accountRollouts } from './accounting.mjs';

const event = (type, task_id, session_id, mission_id = 'm-study') => ({ type, task_id, mission_id, payload: { session_id } });

test('independent inventory retains missing rollout actors, failed launches and additional sessions', () => {
  const inventory = actorInventory([
    event('task_proposed', 't-owner'), event('agent_spawned', 't-owner', 's1'),
    event('agent_spawned', 't-owner', 's1'), event('agent_spawned', 't-owner', 's2'),
    event('task_proposed', 't-child'), event('agent_spawned', 't-extra', 's3'),
    event('agent_spawned', 't-unrelated', 's4', 'm-other'),
  ], 'm-study');
  assert.deepEqual(inventory, [
    {task_id:'t-child', proposed:true, sessions:[]},
    {task_id:'t-extra', proposed:false, sessions:['s3']},
    {task_id:'t-owner', proposed:true, sessions:['s1','s2']},
  ]);
  const accounting = accountRollouts([], inventory.map(a => a.task_id));
  assert.equal(accounting.usage_complete, false);
  assert.deepEqual(accounting.incomplete_actors, ['t-child','t-extra','t-owner']);
});

test('malformed spawn evidence fails explicitly rather than dropping an actor', () => {
  assert.throws(() => actorInventory([event('agent_spawned', 't-owner')], 'm-study'), /session_id/);
  assert.throws(() => actorInventory([event('task_proposed', undefined)], 'm-study'), /task_id/);
});
