import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TaskContract} from '../../packages/protocol/dist/contract.js';
import {buildFixture} from './fixtures.mjs';
import {childContract, assertArmGate} from './arm-control.mjs';
const steps = buildFixture('evidence-service',17).steps;
function gate(arm = 'checkpoint') {
  const contract = TaskContract.parse({...childContract(steps[0],0,arm),mission_id:'m-study',version:1,sender:`agent:owner-${arm}`,parent_task:'t-owner',...(arm==='checkpoint'?{context_id:'b92eac01-8b6c-4bfc-94c9-a8eb3735643b'}:{})});
  return {arm,steps,completed:1,views:[{id:'t-owner'},{id:'t-step-1',contract,task_state:'completed'}],inventory:[{task_id:'t-owner',sessions:['s-owner']},{task_id:'t-step-1',sessions:['s-child']}],operations:arm==='checkpoint'?[{actor:'t-owner',operation:'update',status:'ok'},{actor:'t-step-1',operation:'delivery',status:'ok'},{actor:'t-step-1',operation:'propose',status:'ok'},{actor:'t-owner',operation:'review',status:'ok'}]:[],pending:[]};
}
test('canonical delegated contracts and successful reviewed checkpoint flow pass',()=>{
  assert.equal(assertArmGate(gate()).successful_reviews,1);
  assert.equal(assertArmGate(gate('task-only')).semantic_audit,'pending');
});
test('rejects extra hints, widened scope, revisions, dependencies and wrong context',()=>{
  for(const mutate of [c=>c.goal+=' hidden hint',c=>c.constraints.push('extra'),c=>c.scope.allowed_paths.push('docs/a'),c=>c.version++,c=>c.dependencies.push('t-extra'),c=>c.context.tags.push('extra')]) {
    const input=gate(); mutate(input.views[1].contract); assert.throws(()=>assertArmGate(input),/modified contract/);
  }
});
test('missing actor, multiple sessions and session reuse fail even when contracts match',()=>{
  for(const mutate of [x=>x.inventory.pop(),x=>x.inventory[1].sessions.push('s2'),x=>x.inventory[1].sessions=['s-owner']]) {
    const input=gate();mutate(input);assert.throws(()=>assertArmGate(input),/session/);
  }
});
test('failed proposal call, pending proposal and missing review do not establish completion',()=>{
  for(const mutate of [x=>x.operations[2].status='error',x=>x.pending.push({id:'p'}),x=>x.operations.pop()]) {
    const input=gate();mutate(input);assert.throws(()=>assertArmGate(input),/proposal|propose/);
  }
});
test('baseline forbids checkpoint calls and warm forbids child tasks',()=>{
  const baseline=gate('task-only');baseline.operations.push({operation:'read',status:'error'});
  assert.throws(()=>assertArmGate(baseline),/checkpoint use/);
  const warm=gate();warm.arm='warm';assert.throws(()=>assertArmGate(warm),/unexpected/);
  warm.views=warm.views.slice(0,1);warm.inventory=warm.inventory.slice(0,1);warm.operations=[];
  assert.equal(assertArmGate(warm).checked_tasks.length,1);
});
