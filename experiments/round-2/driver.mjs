#!/usr/bin/env node
/**
 * Round-2 paired pilot driver: the same task, once through a bare `codex exec` (native) and once through
 * RelayGraph (entente: relayd + termd + a hand-written contract), then hidden verification of the artefact.
 *
 *   node experiments/round-2/driver.mjs <case> <native|entente> [--run N] [--model gpt-6-astra] [--decision link|code]
 *                                       [--timeout-s 600] [--out /tmp/entente-r2]
 *
 * Everything the agents can see lives in cases/<id>/{task.md,history.md,plan.yaml}; the oracle under
 * cases/<id>/oracle is copied into the candidate only after the agent has stopped.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const caseId = args[0];
const arm = args[1];
if (!caseId || !['native', 'entente'].includes(arm ?? '')) {
  console.error('usage: driver.mjs <case> <native|entente> [--run N] [--model M] [--decision D] [--timeout-s N] [--out DIR]');
  process.exit(2);
}
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const runNo = Number(opt('run', '1'));
const model = opt('model', 'gpt-6-astra');
const timeoutS = Number(opt('timeout-s', '600'));
const outRoot = opt('out', '/tmp/entente-r2');
const caseDir = path.join(ROOT, 'experiments', 'round-2', 'cases', caseId);
const spec = JSON.parse(fs.readFileSync(path.join(caseDir, 'case.json'), 'utf8'));
const answers = JSON.parse(fs.readFileSync(path.join(caseDir, 'answers.json'), 'utf8'));
const decision = opt('decision', answers.decision_values ? answers.decision_values[Math.floor(Math.random() * answers.decision_values.length)] : undefined);
const stamp = new Date().toISOString().slice(0, 10);
const out = path.join(outRoot, stamp, `${caseId}-${arm}-${runNo}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const repo = path.join(out, 'repo');
const log = (line) => { const s = `${new Date().toISOString().slice(11, 19)} ${line}`; console.log(s); fs.appendFileSync(path.join(out, 'driver.log'), `${s}\n`); };
const record = { case: caseId, arm, run: runNo, model, decision, timeout_s: timeoutS, out, started_at: new Date().toISOString() };
const save = () => fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(record, null, 2));

// ---------- repo ----------
execFileSync('bash', [path.join(ROOT, 'demo-repo', 'scripts', 'init-demo.sh'), '--force', repo], { stdio: 'ignore' });
execFileSync('cp', ['-R', path.join(ROOT, 'demo-repo', 'node_modules'), path.join(repo, 'node_modules')]);
for (const [rel, src] of Object.entries(spec.repo_docs ?? {})) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.copyFileSync(path.join(caseDir, src), path.join(repo, rel));
}
if (spec.repo_docs) {
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=pilot@example.com', '-c', 'user.name=pilot', 'commit', '-q', '-m', 'pilot: task and history'], { cwd: repo });
}
record.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
save();
log(`repo ${repo} @ ${record.base.slice(0, 7)} decision=${decision ?? '-'}`);

const task = fs.readFileSync(path.join(caseDir, 'task.md'), 'utf8');
const history = fs.readFileSync(path.join(caseDir, 'history.md'), 'utf8');
const deadline = Date.now() + timeoutS * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function answerFor(text) {
  for (const rule of answers.rules) {
    if (new RegExp(rule.match, 'i').test(text)) {
      const a = rule.answer;
      return typeof a === 'string' ? a : a[decision];
    }
  }
  return answers.default;
}

// ---------- native ----------
async function runNative() {
  const prompt = `${task}\n\n## Conversation history so far\n\n${history}\n\nYou are working alone in a non-interactive session: nobody can answer questions. If a requirement is undecided in the history, choose the most reasonable option, state the assumption in your final message, and implement it.\n`;
  fs.writeFileSync(path.join(out, 'prompt.md'), prompt);
  const events = path.join(out, 'codex-events.jsonl');
  const child = spawn('gtimeout', ['--foreground', '--signal=TERM', '--kill-after=5s', `${timeoutS}s`, 'codex', 'exec', '-C', repo, '-s', 'workspace-write', '--skip-git-repo-check', '-m', model, '-c', 'model_reasoning_effort="high"', '-c', 'features.apps=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false', '--json', '-o', path.join(out, 'last-message.md'), '-'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(prompt);
  const outStream = fs.createWriteStream(events);
  child.stdout.pipe(outStream);
  child.stderr.pipe(fs.createWriteStream(path.join(out, 'codex-stderr.log')));
  const code = await new Promise((resolve) => child.on('exit', (c, s) => resolve(c ?? (s === 'SIGKILL' ? 137 : 124))));
  record.exit_code = code;
  record.timed_out = code === 124 || code === 137;
  const lines = fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const turn = lines.filter((e) => e.type === 'turn.completed').at(-1);
  record.usage = turn?.usage ?? null;
  record.thread_id = lines.find((e) => e.type === 'thread.started')?.thread_id;
  record.commands = lines.filter((e) => e.type === 'item.completed' && e.item?.type === 'command_execution').length;
  record.candidate = repo;
  log(`native exit=${code} commands=${record.commands} usage=${JSON.stringify(record.usage)}`);
}

// ---------- entente ----------
async function freePort() { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

async function runEntente() {
  const port = await freePort();
  const state = path.join(out, 'state');
  fs.mkdirSync(state, { recursive: true });
  const env = { ...process.env, RELAY_HOST: 'relayterm', RELAY_REPO: repo, RELAY_PORT: String(port), RELAY_DIR: state, RELAY_CODEX_MODEL: model, RELAY_TERMD: path.join(ROOT, 'target', 'debug', 'termd'), RELAY_RUN_ID: `run-${caseId}-${runNo}` };
  const relayd = spawn(process.execPath, [path.join(ROOT, 'apps', 'relayd', 'dist', 'index.js')], { env, stdio: ['ignore', fs.openSync(path.join(out, 'relayd.log'), 'a'), fs.openSync(path.join(out, 'relayd.log'), 'a')] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`${url}/health`); if (r.ok) break; } catch {} await sleep(200); }
  const token = fs.readFileSync(path.join(state, 'session.token'), 'utf8').trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const cli = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'apps', 'cli', 'dist', 'index.js'), ...a], { env: { ...process.env, RELAY_TOKEN: token, RELAY_URL: url, RELAY_REPO: repo }, encoding: 'utf8', timeout: 60_000 });
  let planned;
  if (spec.planner) {
    // The main agent (planner) gets the task and the raw history through the mission; recipients only ever see
    // the contract it writes (plus the repo), which is the handoff under test.
    const successDefinition = spec.history_via === 'mission' ? `${task}\n\n## Conversation history so far\n\n${history}` : task;
    const created = await (await fetch(`${url}/missions`, { method: 'POST', headers, body: JSON.stringify({ repo, title: spec.mission_title ?? `${caseId} round-2 pilot`, success_definition: successDefinition }) })).json();
    record.mission_id = created.mission_id;
    const spawned = await (await fetch(`${url}/missions/${record.mission_id}/planner`, { method: 'POST', headers, body: JSON.stringify({ runtime: spec.planner }) })).json();
    record.planner_pane = spawned.pane_id;
    record.task_ids = [];
    record.planner = spec.planner;
    planned = record.mission_id;
  } else {
    const plan = path.join(caseDir, 'plan.yaml');
    planned = cli('up', `${caseId} round-2 pilot`, '--plan', plan, '--repo', repo);
    record.mission_id = planned.trim().split('\n')[0];
    record.task_ids = parseYaml(fs.readFileSync(plan, 'utf8')).tasks.map((t) => t.id);
  }
  save();
  log(`entente relayd :${port} mission ${record.mission_id} ${spec.planner ? `planner ${spec.planner}` : `tasks ${record.task_ids.join(',')}`}`);

  let seq = 0; const answered = new Set(); record.clarifications = []; record.replies = []; record.mission_clarifications = [];
  let terminal;
  while (Date.now() < deadline) {
    const r = await fetch(`${url}/events/log?since=${seq}`, { headers });
    const events = await r.json();
    for (const e of events) {
      seq = Math.max(seq, e.seq);
      if (e.mission_id !== record.mission_id) continue;
      if (['progress_reported', 'task_blocked', 'clarification_requested', 'mission_clarification_requested', 'task_proposed', 'lint_reported', 'check_failed', 'task_verified', 'mission_verified', 'mission_failed', 'mission_canceled', 'repair_requested'].includes(e.type)) log(`event ${e.type} ${e.task_id ?? ''} ${(e.payload.message ?? e.payload.reason ?? '').slice(0, 100)}`);
      if (e.type === 'task_proposed' && e.task_id && !record.task_ids.includes(e.task_id)) record.task_ids.push(e.task_id);
      if (e.type === 'mission_clarification_requested') {
        const qs = e.payload.questions;
        const body = { answers: qs.map((q) => ({ question_id: q.id, answer: answerFor(q.text) })) };
        record.mission_clarifications.push({ questions: qs.map((q) => q.text), answers: body.answers.map((a) => a.answer) });
        const res = await fetch(`${url}/missions/${record.mission_id}/clarify`, { method: 'POST', headers, body: JSON.stringify(body) });
        log(`answered ${qs.length} mission question(s) → ${res.status}`);
      }
      if (e.type === 'clarification_requested' && !answered.has(`${e.task_id}:${e.payload.contract_version}`)) {
        answered.add(`${e.task_id}:${e.payload.contract_version}`);
        const qs = e.payload.response.questions;
        const body = { answers: qs.map((q) => ({ question_id: q.id, answer: answerFor(q.text) })) };
        record.clarifications.push({ task_id: e.task_id, version: e.payload.contract_version, questions: qs.map((q) => q.text), answers: body.answers.map((a) => a.answer) });
        const res = await fetch(`${url}/tasks/${e.task_id}/clarify`, { method: 'POST', headers, body: JSON.stringify(body) });
        log(`answered ${qs.length} question(s) for ${e.task_id} → ${res.status}`);
      }
      if (e.type === 'task_blocked' && e.payload.waiting_on === 'human') {
        const message = answers.blocker ?? 'Proceed with the contract as written; no additional requirements. If you cannot, state why in your evidence summary and submit.';
        record.replies.push({ task_id: e.task_id, reason: e.payload.reason, message });
        await fetch(`${url}/tasks/${e.task_id}/reply`, { method: 'POST', headers, body: JSON.stringify({ message }) });
        log(`replied to blocker on ${e.task_id}`);
      }
      if (['mission_verified', 'mission_failed', 'mission_canceled'].includes(e.type)) terminal = e;
    }
    if (terminal) break;
    await sleep(2000);
  }
  record.terminal_event = terminal ? { seq: terminal.seq, type: terminal.type, reason: terminal.payload?.reason } : null;
  record.timed_out = !terminal;
  if (!terminal) { for (const t of record.task_ids) { try { cli('cancel', t, 'pilot deadline'); } catch {} } }
  try { record.metrics = await (await fetch(`${url}/metrics`, { headers })).json(); } catch {}
  try { record.pane_metrics_table = cli('pane', 'metrics'); } catch {}
  const runDir = path.join(state, 'runs', env.RELAY_RUN_ID);
  fs.copyFileSync(path.join(runDir, 'events.jsonl'), path.join(out, 'events.jsonl'));
  // usage: every Codex rollout under the per-agent homes
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, sessions: 0 };
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.jsonl') && p.includes('/sessions/')) { const lines = fs.readFileSync(p, 'utf8').split('\n'); const totals = lines.map((l) => /"total_token_usage":(\{[^}]*\})/.exec(l)?.[1]).filter(Boolean); if (totals.length) { const t = JSON.parse(totals.at(-1)); usage.sessions++; for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) usage[k] += t[k] ?? 0; } } } };
  try { walk(path.join(state, 'agents')); } catch {}
  record.usage = usage;
  relayd.kill('SIGTERM');
  await new Promise((r) => relayd.on('exit', r));
  const verified = terminal?.type === 'mission_verified';
  const firstTask = record.task_ids.find((t) => fs.existsSync(path.join(repo, '.relay', 'wt', t)));
  record.candidate = verified ? path.join(repo, '.relay', 'wt', 'integration') : (firstTask ? path.join(repo, '.relay', 'wt', firstTask) : repo);
  record.candidate_kind = verified ? 'integration' : 'task-worktree';
  log(`entente terminal=${terminal?.type ?? 'timeout'} usage=${JSON.stringify(usage)}`);
}

// ---------- hidden verification ----------
function globToRegex(glob) { return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`); }

function verify() {
  const cand = record.candidate;
  const changed = execFileSync('git', ['diff', '--name-only', '--no-renames', record.base, '--'], { cwd: cand, encoding: 'utf8' }).split('\n').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: cand, encoding: 'utf8' }).split('\n').filter(Boolean);
  const paths = [...new Set([...changed, ...untracked])].filter((p) => !p.startsWith('.relay/') && p !== 'node_modules');
  const allowed = spec.allowed_paths.map(globToRegex);
  const disallowed = paths.filter((p) => !allowed.some((re) => re.test(p)));
  const leaks = [];
  for (const pat of spec.leak_patterns ?? []) for (const p of paths) { try { if (new RegExp(pat).test(fs.readFileSync(path.join(cand, p), 'utf8'))) leaks.push({ pattern: pat, file: p }); } catch {} }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `r2-verify-${caseId}-`));
  execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.relay', '--exclude', '.git', `${cand}/`, `${tmp}/`]);
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(tmp, 'node_modules'));
  const run = (cmd, a) => { try { const stdout = execFileSync(cmd, a, { cwd: tmp, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true, exitCode: 0, output: stdout.slice(-2000) }; } catch (e) { return { ok: false, exitCode: e.status ?? -1, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(-3000) }; } };
  // typecheck judges the candidate alone; the oracle files are copied in afterwards
  const typecheck = run('npm', ['run', 'typecheck']);
  const oracleDir = path.join(tmp, 'tests', 'oracle');
  fs.mkdirSync(oracleDir, { recursive: true });
  const oracleFile = spec.oracle_by_decision ? spec.oracle_by_decision[decision] : spec.oracle;
  for (const f of fs.readdirSync(path.join(caseDir, 'oracle'))) if (f.startsWith('_') || path.join('oracle', f) === oracleFile) fs.copyFileSync(path.join(caseDir, 'oracle', f), path.join(oracleDir, f));
  const oracle = run('npx', ['vitest', 'run', 'tests/oracle', '--reporter=dot']);
  record.verification = { candidate: cand, oracle_file: oracleFile, changed_paths: paths, disallowed_paths: disallowed, leaks, oracle: { ok: oracle.ok, tail: oracle.output.slice(-1200) }, typecheck: { ok: typecheck.ok, tail: typecheck.output.slice(-600) } };
  record.artifact_success = oracle.ok && typecheck.ok && disallowed.length === 0 && leaks.length === 0;
  fs.rmSync(tmp, { recursive: true, force: true });
}

const t0 = Date.now();
try {
  if (args.includes('--skip-agent')) { record.candidate = repo; record.skipped_agent = true; log('agent skipped (oracle RED check)'); }
  else if (arm === 'native') await runNative(); else await runEntente();
} catch (err) {
  record.error = String(err?.stack ?? err);
  log(`ERROR ${record.error.slice(0, 300)}`);
}
record.elapsed_ms = Date.now() - t0;
record.ended_at = new Date().toISOString();
save();
try { verify(); } catch (err) { record.verification = { error: String(err?.stack ?? err) }; record.artifact_success = false; }
save();
log(`RESULT ${caseId} ${arm} run ${runNo}: artifact=${record.artifact_success} oracle=${record.verification?.oracle?.ok} typecheck=${record.verification?.typecheck?.ok} scope_violations=${record.verification?.disallowed_paths?.length} leaks=${record.verification?.leaks?.length} ${Math.round(record.elapsed_ms / 1000)}s`);
