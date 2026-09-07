import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixture } from './fixtures.mjs';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { publicStep, ownerContract, runSequence } from './native-driver.mjs';

test('released task payload never contains hidden oracle or future source updates', () => {
  const fixture = buildFixture('evidence-service', 17);
  for (const [i, step] of fixture.steps.entries()) {
    const checkpoint = publicStep(step, i, 'checkpoint');
    const baseline = publicStep(step, i, 'task-only');
    const { context, child_contract, ...common } = checkpoint;
    const {child_contract: baselineChild, ...baselineCommon} = baseline;
    assert.deepEqual(common, baselineCommon);
    assert.equal(child_contract.goal, baselineChild.goal);
    assert.deepEqual(child_contract.scope, baselineChild.scope);
    assert.equal(JSON.stringify(child_contract).includes('oracle'), false);
    assert.equal('oracle' in checkpoint, false);
    assert.equal('updates' in checkpoint, false);
    assert.deepEqual(context.tags, step.tags);
  }
});

test('delegating owner and child output scopes are disjoint; warm owner can perform the same steps', () => {
  const fixture = buildFixture('research-accounting', 96);
  for (const arm of ['checkpoint', 'task-only']) {
    const owner = ownerContract(fixture, arm);
    for (const step of fixture.steps) for (const file of step.allowed_paths) assert.equal(owner.scope.allowed_paths.includes(file), false);
    assert.equal(owner.constraints.some(c => c.includes('study-ready-0')), true);
  }
  const warm = ownerContract(fixture, 'warm');
  for (const step of fixture.steps) for (const file of step.allowed_paths) assert.ok(warm.scope.allowed_paths.includes(file));
});

async function temporarySequence(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-finalize-')));
  const directory = path.join(root, 'trial');
  try { await run(directory); } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('setup failure remains an assigned six-step sample and never starts a model', async () => {
  await temporarySequence(async directory => {
    let launched = false;
    const result = await runSequence({directory, family:'invalid', seed:17, arm:'checkpoint'}, {
      startDaemon: async () => { launched = true; throw Error('must not run'); },
    });
    assert.equal(launched, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.planned_steps, 6);
    assert.equal(result.quality.length, 6);
    assert.equal(result.archived_steps, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'assignment.json'))).planned_steps, 6);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'result.json'))).status, 'failed');
  });
});

test('shutdown, accounting and ledger failures are isolated and all remain in durable result', async () => {
  await temporarySequence(async directory => {
    const called = [];
    const result = await runSequence({directory, family:'evidence-service', seed:17, arm:'checkpoint'}, {
      startDaemon: async () => ({fakes:['test'], close: async () => { called.push('shutdown'); throw Error('shutdown injected'); }}),
      account: () => { called.push('accounting'); throw Error('conflicting response usage injected'); },
      ledger: () => { called.push('ledger'); throw Error('ledger injected'); },
    });
    assert.deepEqual(called, ['shutdown','accounting','ledger']);
    assert.equal(result.passed, false);
    assert.equal(result.accounting, null);
    assert.deepEqual(result.errors.map(e => e.stage), ['workflow','shutdown','accounting','access_ledger']);
    const durable = JSON.parse(fs.readFileSync(path.join(directory,'result.json')));
    assert.deepEqual(durable.errors, result.errors);
    assert.equal(durable.quality.length, 6);
    assert.ok(durable.timings.setup.duration_ms >= 0);
    assert.ok(durable.timings.shutdown.start_ms >= durable.timings.setup.duration_ms);
    assert.ok(durable.end_to_end_ms >= durable.workflow_elapsed_ms);
  });
});

function simulatedWarmRuntime({tamper = false} = {}) {
  return async env => {
    const repo = env.RELAY_REPO, relayDir = env.RELAY_DIR, ownerPath = path.join(relayDir,'wt','owner');
    const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8',stdio:'pipe'}).trim();
    let gate = 'study-ready-0', done = false;
    fs.mkdirSync(path.dirname(ownerPath),{recursive:true});
    git(repo,'worktree','add','-b','relay/t-owner',ownerPath);
    const eventDir=path.join(relayDir,'runs','test');fs.mkdirSync(eventDir,{recursive:true});
    fs.writeFileSync(path.join(eventDir,'events.jsonl'), JSON.stringify({type:'agent_spawned',mission_id:'m-test',task_id:'t-owner',payload:{session_id:'test-owner'}})+'\n');
    return {fakes:[], url:'http://unused.invalid',close:async()=>{},orchestrator:{
      createMission:()=>({mission_id:'m-test'}),proposeTask:async()=>({status:'proposed'}),
      getMission:()=>({task_ids:['t-owner'],status:done?'verified':'executing'}),
      taskView:()=>({id:'t-owner',worktree:{path:ownerPath},blocker:{waiting_on:gate},task_state:done?'completed':'executing'}),
      reply:(_id,message)=>{
        if(message.startsWith('FINISH')) {done=true;return;}
        const step=JSON.parse(message.slice(5));
        for(const file of step.allowed_paths){fs.mkdirSync(path.dirname(path.join(ownerPath,file)),{recursive:true});fs.writeFileSync(path.join(ownerPath,file),'export const placeholder = true;\n');}
        git(ownerPath,'add','--',...step.allowed_paths);git(ownerPath,'commit','-m','Simulated public output');
        if(tamper && step.index===2){const original=fs.readFileSync(path.join(ownerPath,'README.md'));fs.writeFileSync(path.join(ownerPath,'README.md'),'tampered');git(ownerPath,'add','README.md');git(ownerPath,'commit','-m','Simulated contamination');fs.writeFileSync(path.join(ownerPath,'README.md'),original);}
        gate=`study-ready-${step.index}`;
      },
    }};
  };
}

test('full controller retains six archived slots when one post-run oracle throws', async()=>{
  await temporarySequence(async directory=>{
    const evaluated=[];
    const result=await runSequence({directory,family:'evidence-service',seed:17,arm:'warm'},{
      startDaemon:simulatedWarmRuntime(),account:()=>({usage_complete:true,known_usage:{uncached_input_tokens:0,output_tokens:0}}),ledger:()=>[],
      evaluate:async(_fixture,index)=>{evaluated.push(index);if(index===2)throw Error('oracle injected');return {passed:true,checks:[]};},
    });
    assert.equal(result.archived_steps,6);
    assert.deepEqual(evaluated,[0,1,2,3,4,5]);
    assert.equal(result.quality.filter(q=>q.passed).length,5);
    assert.equal(result.quality[2].status,'evaluation_pending');
    assert.equal(result.status,'failed');
    assert.equal(result.mission_status,'verified');
    assert.ok(result.errors.some(e=>e.stage==='oracle_step_3'));
  });
});

test('controller rejects committed source contamination restored only on disk before archive',async()=>{
  await temporarySequence(async directory=>{
    const result=await runSequence({directory,family:'evidence-service',seed:17,arm:'warm'},{
      startDaemon:simulatedWarmRuntime({tamper:true}),account:()=>({usage_complete:true,known_usage:{uncached_input_tokens:0,output_tokens:0}}),ledger:()=>[],evaluate:async()=>({passed:true,checks:[]}),
    });
    assert.equal(result.archived_steps,1);
    assert.match(result.failure,/committed bytes mismatch/);
    assert.equal(result.quality.length,6);
  });
});
