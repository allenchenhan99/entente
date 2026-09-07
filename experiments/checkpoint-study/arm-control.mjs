import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TaskContract } from '../../packages/protocol/dist/contract.js';
import { CheckpointStore } from '../../apps/relayd/dist/checkpoint/store.js';

export function childContract(step, index, arm) {
  if (!['checkpoint', 'task-only'].includes(arm)) throw new Error('delegating arm required');
  return {
    id: `t-step-${index + 1}`, recipient: `step-${index + 1}`, runtime: 'codex', goal: step.goal,
    inputs: ['README.md', 'docs/README.md'],
    constraints: [
      'Implement the named synchronous export using the public repository sources and their stated precedence. Internal implementation choices and cleaned temporary test files are authorized. No human design approval is pending. Do not browse the network or inspect outside this repository. No further delegation.',
      'Modify only the assigned output paths. Read current policy files at runtime so subsequent source releases do not require edits to earlier outputs. Run the public checks and submit evidence. Do not write reusable notebooks, concealed notes or extra summaries in code.',
      ...(arm === 'checkpoint' ? [
        'Consume get_contract context/context_validation. Use relay_get_context for specific missing IDs/tags and current owner revision; verify stale facts against current public sources. Before evidence propose incremental source-backed findings using relay_propose_context_delta with current contract_version and latest base_revision. An empty upsert/remove is allowed if nothing new was learned. Inspect isError: on revision conflict retrieve current context, reconcile and retry. Only a returned proposal ID proves successful submission. Do not submit final evidence before that succeeds.',
      ] : ['Do not use relay_checkpoint, relay_get_context or relay_propose_context_delta. Use public sources as needed.']),
    ],
    non_goals: ['No network access', 'No outside-repository access', 'No further delegation', 'No source-document edits'],
    scope: {allowed_paths: step.allowed_paths},
    acceptance_criteria: [
      {id: 'AC-1', condition: 'Public syntax checks pass', check: {kind:'command', run:step.allowed_paths.map(file => `node --check ${file}`).join(' && '), timeout_ms:120000}},
      {id: 'AC-2', condition: 'Only assigned outputs changed', check: {kind:'diff_scope'}},
    ],
    output: {type:'code_change', evidence_required:['git_diff','changed_files','check_outputs']},
    dependencies: [], budget: {max_repairs:1, stagnation_limit:2},
    ...(arm === 'checkpoint' ? {context:{ids:[], tags:step.tags, max_bytes:16384}} : {}),
  };
}

/** Checks recorded behavior at a quiescent step gate; semantic tool-trace audit remains separate. */
export function assertArmGate({arm, steps, completed, views, inventory, operations, pending}) {
  const expectedIds = ['t-owner', ...(arm === 'warm' ? [] : steps.slice(0, completed).map((_, i) => `t-step-${i + 1}`))];
  if (!isDeepStrictEqual(views.map(v => v.id).sort(), [...expectedIds].sort())) throw Error('arm violation: unexpected or missing task');
  const sessions = new Set();
  for (const id of expectedIds) {
    const actor = inventory.find(a => a.task_id === id);
    if (!actor || actor.sessions.length !== 1 || sessions.has(actor.sessions[0])) throw Error(`arm violation: missing, repeated or reused session for ${id}`);
    sessions.add(actor.sessions[0]);
  }
  if (inventory.some(a => !expectedIds.includes(a.task_id))) throw Error('arm violation: extra actor');
  if (arm !== 'warm') for (let i = 0; i < completed; i++) {
    const view = views.find(v => v.id === `t-step-${i + 1}`), actual = view.contract;
    const expected = TaskContract.parse({...childContract(steps[i], i, arm), mission_id:actual.mission_id, version:1, sender:`agent:owner-${arm}`, parent_task:'t-owner'});
    const {context_id, ...comparable} = actual;
    if (!isDeepStrictEqual(comparable, expected)) throw Error(`arm violation: modified contract for ${view.id}`);
    if (arm === 'checkpoint' && !context_id) throw Error(`arm violation: missing frozen packet for ${view.id}`);
    if (arm !== 'checkpoint' && context_id) throw Error(`arm violation: unexpected packet for ${view.id}`);
    if (view.task_state !== 'completed') throw Error(`arm violation: child not completed: ${view.id}`);
  }
  if (arm !== 'checkpoint') {
    if (operations.length) throw Error('arm violation: checkpoint use outside checkpoint arm');
    return {checked_tasks:expectedIds, checked_sessions:[...sessions], semantic_audit:'pending'};
  }
  const ok = operations.filter(o => o.status === 'ok');
  if (!ok.some(o => o.actor === 't-owner' && o.operation === 'update')) throw Error('arm violation: owner checkpoint not initialized');
  for (let i = 1; i <= completed; i++) {
    for (const operation of ['delivery', 'propose']) if (!ok.some(o => o.actor === `t-step-${i}` && o.operation === operation)) throw Error(`arm violation: missing ${operation} for t-step-${i}`);
  }
  if (pending.length || ok.filter(o => o.actor === 't-owner' && o.operation === 'review').length < completed) throw Error('arm violation: unreviewed child proposals');
  return {checked_tasks:expectedIds, checked_sessions:[...sessions], successful_reviews:ok.filter(o => o.operation === 'review').length, semantic_audit:'pending'};
}

export function readCheckpointAudit(relayDir, owner) {
  const directory = path.join(relayDir, 'checkpoints'), file = path.join(directory, 'operations.jsonl');
  const operations = fs.existsSync(file) ? fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  // Read-only ledger inspection does not insert observer calls into measured checkpoint operations.
  const pending = new CheckpointStore(directory).pending(owner);
  return {operations, pending};
}
