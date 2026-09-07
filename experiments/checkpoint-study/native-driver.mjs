import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { main as startRelayd } from '../../apps/relayd/dist/index.js';
import { buildFixture, materializeFixture, applyStep, evaluateStep } from './fixtures.mjs';
import { accountRollouts, readRollouts } from './accounting.mjs';
import { accessLedger } from './access-ledger.mjs';
import { readActorInventory } from './actor-inventory.mjs';
import { assertCommittedIntegrity } from './integrity.mjs';
import { childContract, assertArmGate, readCheckpointAudit } from './arm-control.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
};
const git = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 64 * 1024 * 1024 }).trim();

export function publicStep(step, index, arm) {
  return {
    index: index + 1, task_id: `t-step-${index + 1}`, goal: step.goal, tags: step.tags,
    allowed_paths: step.allowed_paths,
    ...(arm === 'checkpoint' ? { context: { tags: step.tags, max_bytes: 16384 } } : {}),
    ...(arm !== 'warm' ? {child_contract: childContract(step, index, arm)} : {}),
    checks: step.allowed_paths.map(file => `node --check ${file}`),
  };
}

export function ownerContract(fixture, arm) {
  if (!['checkpoint', 'task-only', 'warm'].includes(arm)) throw new Error('invalid arm');
  const publicPaths = [...Object.keys(fixture.files), ...fixture.steps.flatMap(s => Object.keys(s.updates))];
  return {
    id: 't-owner', recipient: `owner-${arm}`, runtime: 'codex',
    goal: `Execute a six-assignment ${fixture.family} workflow. First orient using the public repository, then wait for one assignment at a time through the relay reply tool. Arm: ${arm}.`,
    inputs: ['README.md', 'docs/README.md'],
    constraints: [
      'All substantive product behavior is defined in the public sources. No human design decision is pending. Internal implementation choices and routine test-only temporary files are authorized. Do not browse the network or inspect paths outside this repository. Do not seek private evaluation code. Inputs/docs are read-only to agents; the controller applies announced source changes between assignments.',
      'First accept the contract, read the source register and orient yourself to the current domain rules. Future assignments arrive later. Then relay_report_blocker with reason "Orientation finished" and waiting_on "study-ready-0", and loop relay_await_reply timeout_s 60. This is an expected synchronization gate, not a request for human permission.',
      'The controller sends STEP JSON containing index, task_id, goal, tags, allowed_paths, and public syntax checks. Only that assignment is active. On receiving STEP call relay_report_progress with its index before starting, so the old synchronization blocker clears. After completing each step and all required memory maintenance, report_blocker waiting_on "study-ready-N" where N is that step index, then await_reply. Do not submit your own final evidence until the controller sends FINISH after step 6.',
      ...(arm === 'warm' ? [
        'Do each STEP yourself in this same session; do not delegate or use relay_checkpoint, relay_get_context or relay_propose_context_delta. Implement only the step allowed_paths. Run its public checks, then git add only those output paths and git commit so the controller can carry them forward. Do not write notes or summaries between assignments; native conversation history remains available.',
      ] : [
        'For each STEP call relay_propose_subtask with contract equal to STEP.child_contract exactly, unchanged. Do not add or paraphrase constraints, hints, goals, inputs, checks or context. Do not pass reuse_session: every child must be fresh. Internal implementation details are delegated by the canonical contract. No child may delegate further.',
        'Await child completion with relay_await_task. Ensure its files are present before reporting the step gate. If it fails, report the failure honestly and still reach the step gate; do not solve the child task yourself. Do not write code or add narrative hints to the supplied child goal. Earlier outputs are ordinary source artifacts available in each next checkout.',
        ...(arm === 'checkpoint' ? [
          'During orientation and work incrementally maintain source-backed reusable facts with relay_checkpoint update; do not call a model to rewrite a summary at assignment. Use stable fact IDs, useful domain tags (evidence/identity/history/verification/context/bounds/lineage/conflict or accounting/counters/cache/billing/inclusion/pairing), and source sha256 hashes. Select using exactly STEP.context; do not add narrative summaries to the child contract.',
          'After child completion inspect pending proposals, verify sources and explicitly accept/reject them before the step gate, including step 6. Check isError on every checkpoint operation. On revision conflicts retrieve the current revision, reconcile and retry; do not claim success without a successful tool result. An empty child delta is valid when no new findings exist. Reconcile stale/conflicting proposals explicitly.',
        ] : [
          'Do not use checkpoint tools, context fields, reusable notebooks or narrative handoff summaries. Child constraints must only state ordinary scope, source precedence, syntax verification and protocol rules. The owner may retain its own native conversational understanding for coordination but must not pass hidden hints or solve tasks for children.',
        ]),
      ]),
      'Source changes are applied by the controller while you wait. Revalidate relevant rules when a new STEP arrives. Do not edit any other step output; implementations should read current policy files so later source changes can be consumed without rewriting earlier modules. Never conceal notes in comments or outputs.',
      'On FINISH write results/owner.md with concise observed completion/failure status, then run the final file-existence check and submit evidence. Do not claim functional correctness beyond public checks and do not claim efficiency. Any independent oracle results will be evaluated after archiving, outside your context.',
    ],
    non_goals: ['No network access', 'No hidden oracle access', 'No source-document edits by agents', 'No performance claims'],
    scope: { allowed_paths: [...new Set(['results/owner.md', ...publicPaths, ...(arm === 'warm' ? fixture.steps.flatMap(s => s.allowed_paths) : [])])] },
    acceptance_criteria: [{ id: 'AC-1', condition: 'Workflow report exists', check: { kind: 'file_exists', path: 'results/owner.md' } }, { id: 'AC-2', condition: 'Changes remain within assigned workflow', check: { kind: 'diff_scope' } }],
    output: { type: 'code_change', evidence_required: ['git_diff', 'changed_files', 'check_outputs'] }, dependencies: [], budget: { max_repairs: 1, stagnation_limit: 2 },
  };
}

/** One isolated native sequence. No oracle bytes enter the subject Git object database. */
export async function runSequence({ directory, family, seed, arm, termd, phase = 'instrumentation', stepTimeoutMs = 480000, sequenceTimeoutMs = 3000000 }, dependencies = {}) {
  const startDaemon = dependencies.startDaemon ?? startRelayd;
  const account = dependencies.account ?? accountRollouts;
  const ledger = dependencies.ledger ?? accessLedger;
  const evaluate = dependencies.evaluate ?? evaluateStep;
  const started = performance.now(), started_at = new Date().toISOString();
  if (fs.existsSync(directory)) throw new Error('refusing to reuse a trial directory');
  fs.mkdirSync(directory, { recursive: true });
  const repo = path.join(directory, 'subject'), relayDir = path.join(repo, '.relay');
  const manifest = { family, seed, arm, phase, started_at, step_timeout_ms: stepTimeoutMs, sequence_timeout_ms: sequenceTimeoutMs };
  const timeline = [], archives = [], errors = [], timings = {};
  let fixture, running, mission, failure = null, publicFiles = {}, previousOutputs = {}, logFd;
  const result = { ...manifest, status: 'assigned', failure: null, errors, timings, accounting: null,
    quality: Array.from({length: 6}, (_, index) => ({step: index + 1, status: 'not_archived', passed: false})),
    passed: false, planned_steps: 6, archived_steps: 0 };
  const persist = () => write(path.join(directory, 'result.json'), { ...result, end_to_end_ms: performance.now() - started });
  // Register the denominator before fixture materialization, Git, or model startup can fail.
  write(path.join(directory, 'assignment.json'), { ...manifest, planned_steps: 6 });
  persist();
  const record = (type, data = {}) => { const entry = { type, elapsed_ms: performance.now() - started, ...data }; timeline.push(entry); fs.appendFileSync(path.join(directory, 'timeline.jsonl'), JSON.stringify(entry) + '\n'); console.log(JSON.stringify({ directory, ...entry })); };
  const stage = async (name, operation) => {
    const begin = performance.now();
    try { return await operation(); }
    catch (error) { errors.push({stage: name, message: String(error)}); return undefined; }
    finally { timings[name] = {start_ms: begin - started, duration_ms: performance.now() - begin}; persist(); }
  };
  const expectedActors = () => mission ? [...new Set(['t-owner', ...readActorInventory(relayDir, mission.mission_id).map(actor => actor.task_id)])] : [];
  const checkBudget = () => {
    if (performance.now() - started > sequenceTimeoutMs) throw new Error('sequence wall-time cap');
    const accounting = account(readRollouts(path.join(relayDir, 'agents')), expectedActors());
    if (accounting.known_usage.uncached_input_tokens > 1000000 || accounting.known_usage.output_tokens > 80000) throw new Error('sequence model-token cap');
  };
  const waitFor = async (label, predicate, timeout = stepTimeoutMs) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      checkBudget(); const value = predicate(); if (value) return value;
      const owner = running.orchestrator.taskView('t-owner');
      if (owner && ['failed', 'canceled'].includes(owner.task_state)) throw new Error(`owner ${owner.task_state} while ${label}`);
      await sleep(1000);
    }
    throw new Error(`timeout while ${label}`);
  };
  const validateArm = completed => {
    const views = running.orchestrator.getMission(mission.mission_id).task_ids.map(id => running.orchestrator.taskView(id));
    const inventory = readActorInventory(relayDir, mission.mission_id);
    const audit = assertArmGate({arm, steps:fixture.steps, completed, views, inventory, ...readCheckpointAudit(relayDir, `mission:${mission.mission_id}:task:t-owner`)});
    record('arm_gate_checked', {completed, ...audit});
  };
  const assertSources = (cwd, requiredPaths = []) => assertCommittedIntegrity(cwd, {...publicFiles, ...previousOutputs}, requiredPaths);

  try {
    fixture = buildFixture(family, seed); publicFiles = { ...fixture.files };
    fs.mkdirSync(repo); materializeFixture(fixture, repo);
    git(repo, 'init', '-b', 'study'); git(repo, 'config', 'user.name', 'Entente Study'); git(repo, 'config', 'user.email', 'study@localhost');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Public fixture baseline');
    git(repo, 'branch', 'main'); // Native integration uses main as its baseline.
    Object.assign(manifest, {source_commit: git(sourceRoot, 'rev-parse', 'HEAD'), fixture_sha256: hash(JSON.stringify(fixture)), baseline_sha: git(repo, 'rev-parse', 'HEAD')});
    Object.assign(result, manifest, {status: 'running'});
    write(path.join(directory, 'manifest.json'), manifest);
    write(path.join(directory, 'private-fixture.json'), fixture);
    logFd = fs.openSync(path.join(directory, 'daemon.log'), 'a', 0o600);
    timings.setup = {start_ms: 0, duration_ms: performance.now() - started}; persist();
    running = await startDaemon({ ...process.env, RELAY_REPO: repo, RELAY_DIR: relayDir, RELAY_PORT: '0', RELAY_HOST: 'relayterm', RELAY_TERMD: termd, RELAY_RETAIN_COMPLETED_AGENTS: '1', RELAY_RESUME: undefined, RELAY_RUN_ID: undefined }, message => fs.writeSync(logFd, message + '\n'));
    if (running.fakes.length) throw new Error(`refusing non-native measurement: fake ports ${running.fakes.join(', ')}`);
    write(path.join(directory, 'connection.json'), { url: running.url, repo, relayDir });
    record('daemon_ready', { url: running.url });
    mission = running.orchestrator.createMission({ repo, title: `${phase}: ${family} ${seed} ${arm}`, integration_check: fixture.steps.flatMap(step => step.allowed_paths.map(file => `node --check ${file}`)).join(' && ') });
    const proposed = await running.orchestrator.proposeTask(mission.mission_id, ownerContract(fixture, arm), 'planner');
    if (proposed.status !== 'proposed') throw new Error(`owner lint failed: ${JSON.stringify(proposed)}`);
    const ownerPath = running.orchestrator.taskView('t-owner').worktree.path;
    await waitFor('orientation gate', () => running.orchestrator.taskView('t-owner')?.blocker?.waiting_on === 'study-ready-0');
    validateArm(0);
    record('orientation_finished');
    for (let i = 0; i < fixture.steps.length; i++) {
      const step = fixture.steps[i];
      assertSources(repo);
      applyStep(fixture, i, repo); Object.assign(publicFiles, step.updates);
      if (Object.keys(step.updates).length) { git(repo, 'add', '--', ...Object.keys(step.updates)); git(repo, 'commit', '-m', `Public source release before step ${i + 1}`); }
      git(ownerPath, 'merge', '--no-edit', 'study');
      assertSources(ownerPath);
      record('step_started', { step: i + 1, source_sha: git(repo, 'rev-parse', 'HEAD') });
      running.orchestrator.reply('t-owner', 'STEP ' + JSON.stringify(publicStep(step, i, arm)), 'human');
      await waitFor(`step ${i + 1}`, () => running.orchestrator.taskView('t-owner')?.blocker?.waiting_on === `study-ready-${i + 1}`);
      assertSources(ownerPath);
      if (arm !== 'warm') await waitFor('child landing', () => step.allowed_paths.every(file => { try { git(ownerPath, 'cat-file', '-e', `HEAD:${file}`); return true; } catch { return false; } }), 15000);
      validateArm(i + 1);
      if (arm !== 'warm') {
        const childPath = running.orchestrator.taskView(`t-step-${i + 1}`).worktree.path;
        const childBytes = Object.fromEntries(step.allowed_paths.map(file => [file, fs.readFileSync(path.join(childPath, file), 'utf8')]));
        assertCommittedIntegrity(childPath, {...publicFiles, ...previousOutputs}, step.allowed_paths);
        assertCommittedIntegrity(ownerPath, childBytes, step.allowed_paths);
      }
      const inspectedCommit = assertSources(ownerPath, step.allowed_paths);
      git(repo, 'merge', '--no-edit', inspectedCommit);
      assertSources(repo, step.allowed_paths);
      const archive = path.join(directory, `step-${i + 1}`); fs.mkdirSync(archive);
      const tar = execFileSync('git', ['--no-replace-objects', 'archive', inspectedCommit], { cwd: ownerPath, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
      execFileSync('tar', ['-x', '-C', archive], { input: tar, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
      archives.push({ index: i, path: archive, commit: inspectedCommit });
      for (const file of step.allowed_paths) previousOutputs[file] = fs.readFileSync(path.join(archive, file), 'utf8');
      record('step_archived', { step: i + 1, commit: archives.at(-1).commit });
    }
    running.orchestrator.reply('t-owner', 'FINISH: all six assignments are archived. Complete final maintenance, write results/owner.md and submit evidence.', 'human');
    await waitFor('owner completion', () => running.orchestrator.taskView('t-owner')?.task_state === 'completed');
    await waitFor('all rollout completion markers', () => account(readRollouts(path.join(relayDir, 'agents')), expectedActors()).usage_complete, 120000);
    await waitFor('mission integration', () => {
      const status = running.orchestrator.getMission(mission.mission_id)?.status;
      result.mission_status = status;
      if (status === 'failed') throw new Error('native mission integration failed');
      return status === 'verified';
    });
    validateArm(6);
    record('sequence_finished');
  } catch (error) {
    failure = String(error);
    errors.push({stage: 'workflow', message: failure});
    result.failure = failure;
    await stage('failure_record', () => record('sequence_failed', {reason: failure}));
  } finally {
    result.workflow_elapsed_ms = performance.now() - started;
    // Each finalizer is isolated: a billing conflict must not erase quality or the assigned sample.
    await stage('shutdown', async () => { if (running) await running.close(); });
    let rollouts, inventory;
    await stage('rollouts', () => { rollouts = readRollouts(path.join(relayDir, 'agents')); });
    await stage('inventory', () => {
      inventory = mission ? readActorInventory(relayDir, mission.mission_id) : [];
      write(path.join(directory, 'actor-inventory.json'), inventory);
    });
    await stage('accounting', () => {
      if (!rollouts || !inventory) throw new Error('rollout or inventory collection failed');
      result.accounting = account(rollouts, mission ? [...new Set(['t-owner', ...inventory.map(a => a.task_id)])] : []);
      write(path.join(directory, 'accounting.json'), result.accounting);
    });
    await stage('access_ledger', () => {
      if (!rollouts) throw new Error('rollout collection failed');
      write(path.join(directory, 'access-ledger.json'), ledger(rollouts, timeline, started_at));
    });
    await stage('log_close', () => { if (logFd !== undefined) fs.closeSync(logFd); });
    // Private outcomes are never returned to an active model. A shutdown error prevents evaluation.
    for (const archive of archives) {
      result.quality[archive.index] = {step: archive.index + 1, commit: archive.commit, status: 'evaluation_pending', passed: false};
      if (errors.some(e => e.stage === 'shutdown')) continue;
      await stage(`oracle_step_${archive.index + 1}`, async () => {
        result.quality[archive.index] = {step: archive.index + 1, commit: archive.commit, status: 'evaluated', ...await evaluate(fixture, archive.index, archive.path)};
      });
    }
    result.archived_steps = archives.length;
    result.capped_workflow_ms = Math.min(result.workflow_elapsed_ms, sequenceTimeoutMs);
    result.failure = failure ?? (errors.length ? errors[0].message : null);
    result.status = result.failure ? 'failed' : 'finished';
    result.passed = !result.failure && result.accounting?.usage_complete === true && archives.length === 6 && result.quality.every(q => q.passed);
    persist();
  }
  return { ...result, end_to_end_ms: performance.now() - started };

}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const [directory, family, seed, arm, termd] = process.argv.slice(2);
  if (!directory || !family || seed === undefined || !arm || !termd) throw new Error('usage: native-driver.mjs directory family seed arm termd');
  await runSequence({ directory: path.resolve(directory), family, seed: Number(seed), arm, termd });
}
