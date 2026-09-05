#!/usr/bin/env node
/**
 * Context-handoff cost benchmark. See README.md for the design and the success criteria.
 *
 * Makes real model calls. Writes only inside experiments/context-handoff/results/ and a
 * disposable git worktree per arm under .worktrees/ctxbench-<arm>/.
 *
 * Usage:
 *   node run.mjs --arm A|B|C [--history-tokens 8000] [--tasks T1,T3] [--repeat 1]
 *   node run.mjs --report
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tasks as ALL_TASKS, commonAcceptance } from './case.mjs';
import { selectItems, renderItems } from './select.mjs';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RESULTS = path.join(HERE, 'results');

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

// ---------------------------------------------------------------- usage accounting

/**
 * The runtime's JSON shape is NOT assumed. We map what we recognise and keep the raw
 * object alongside, so a renamed field shows up as `unknown` in the report instead of
 * silently becoming 0. See README "Metrics".
 */
function parseUsage(raw) {
  const u = raw?.usage ?? raw?.message?.usage ?? {};
  const pick = (...names) => {
    for (const n of names) if (typeof u[n] === 'number') return u[n];
    return 'unknown';
  };
  return {
    input_uncached: pick('input_tokens', 'input'),
    input_cache_read: pick('cache_read_input_tokens', 'cacheRead'),
    input_cache_write: pick('cache_creation_input_tokens', 'cacheWrite'),
    output: pick('output_tokens', 'output'),
    cost_usd: typeof raw?.total_cost_usd === 'number' ? raw.total_cost_usd : 'unknown',
    _raw: u,
  };
}

const isNum = (v) => typeof v === 'number';
const addUsage = (a, b) => {
  const out = {};
  for (const k of ['input_uncached', 'input_cache_read', 'input_cache_write', 'output']) {
    out[k] = isNum(a[k]) && isNum(b[k]) ? a[k] + b[k] : 'unknown';
  }
  out.cost_usd = isNum(a.cost_usd) && isNum(b.cost_usd) ? a.cost_usd + b.cost_usd : 'unknown';
  return out;
};
const ZERO = { input_uncached: 0, input_cache_read: 0, input_cache_write: 0, output: 0, cost_usd: 0 };

// ---------------------------------------------------------------- model call

async function callClaude(prompt, cwd, { allowWrite }) {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (allowWrite) args.push('--dangerously-skip-permissions');
  const started = Date.now();
  let stdout = '';
  let failure = null;
  try {
    ({ stdout } = await exec('claude', args, { cwd, maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    failure = e.message;
    stdout = e.stdout ?? '';
  }
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* leave null; usage becomes unknown rather than 0 */
  }
  return {
    text: json?.result ?? stdout,
    usage: parseUsage(json),
    wall_clock_ms: Date.now() - started,
    failure,
  };
}

// ---------------------------------------------------------------- context construction

const contractOf = (task, common) => [
  `## Task ${task.id}`,
  '',
  task.goal.trim(),
  '',
  `Allowed paths (do not touch anything else): ${task.allowedPaths.join(', ')}`,
  '',
  'Acceptance:',
  ...common.map((c) => `- ${c.id}: ${c.condition}`),
  '- Hidden behavioural checks will be run against your module after you finish.',
].join('\n');

/** Arm B: the main agent writes the brief itself, from its own accumulated history. */
async function mainAuthoredBrief(task, history, cwd) {
  const prompt = [
    'You are the main agent on this project. Below is your prior conversation history.',
    'You are about to delegate the task at the end to a fresh subagent that has NO access',
    'to this history and cannot ask you questions.',
    '',
    'Write the briefing you would hand that subagent. Include whatever standing decisions,',
    'constraints and conventions it needs in order to get the task right first time.',
    'Output only the briefing text.',
    '',
    '--- YOUR HISTORY ---',
    history,
    '--- END HISTORY ---',
    '',
    '--- TASK TO DELEGATE ---',
    task.goal.trim(),
    `Allowed paths: ${task.allowedPaths.join(', ')}`,
  ].join('\n');
  return callClaude(prompt, cwd, { allowWrite: false });
}

/** Arm C: one extraction over the history, reused for every task. */
async function extractItems(history, cwd) {
  const prompt = [
    'Extract the standing facts from the conversation history below into a JSON array.',
    '',
    'Each element: {"id","text","kind","source_turn","related_paths","supersedes"}.',
    '',
    'Rules for "kind" — derive it from WHO said it, never from how confident it sounds:',
    '  human_confirmed  the fact originates in a [human] turn',
    '  check_verified   the fact is asserted by a [check] block that PASSED',
    '  agent_reported   everything else, including confident [agent] claims',
    '',
    'If a later turn contradicts an earlier one, emit the later fact and list the earlier',
    'id in its "supersedes". Do not emit superseded facts as standalone live facts.',
    '',
    'Extract everything that reads as a standing decision, constraint or convention,',
    'including ones that look irrelevant to any particular task. Selection happens later.',
    '',
    'Output only the JSON array.',
    '',
    '--- HISTORY ---',
    history,
  ].join('\n');
  const res = await callClaude(prompt, cwd, { allowWrite: false });
  let items = [];
  const m = res.text.match(/\[[\s\S]*\]/);
  try {
    items = JSON.parse(m ? m[0] : res.text);
  } catch {
    items = [];
  }
  return { items, usage: res.usage, wall_clock_ms: res.wall_clock_ms, raw: res.text };
}

// ---------------------------------------------------------------- worktree

async function makeWorktree(arm, runId) {
  const dir = path.join(REPO, '.worktrees', `ctxbench-${arm}-${runId.slice(0, 8)}`);
  await exec('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: REPO });
  const demo = path.join(dir, 'demo-repo');
  // Reuse the main checkout's install; a fresh npm ci per arm dominates the wall clock.
  const src = path.join(REPO, 'demo-repo', 'node_modules');
  if (await fs.stat(src).then(() => true, () => false)) {
    await fs.cp(src, path.join(demo, 'node_modules'), { recursive: true });
  } else {
    await exec('npm', ['install'], { cwd: demo });
  }
  return { dir, demo };
}

async function dropWorktree(dir) {
  await exec('git', ['worktree', 'remove', '--force', dir], { cwd: REPO }).catch(() => {});
}

// ---------------------------------------------------------------- verification

async function verify(demo, task) {
  const oracleSrc = path.join(HERE, task.oracle);
  const oracleDst = path.join(demo, 'tests', path.basename(task.oracle));
  await fs.copyFile(oracleSrc, oracleDst);
  const out = {};
  try {
    const r = await exec('npx', ['vitest', 'run', path.relative(demo, oracleDst)], { cwd: demo });
    out.checks_passed = true;
    out.check_output = r.stdout.slice(-4000);
  } catch (e) {
    out.checks_passed = false;
    out.check_output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(-4000);
  }
  try {
    await exec('npm', ['run', 'typecheck'], { cwd: demo });
    out.typecheck_passed = true;
  } catch (e) {
    out.typecheck_passed = false;
    out.check_output += `\n[typecheck]\n${(e.stdout ?? '') + (e.stderr ?? '')}`.slice(-2000);
  }
  await fs.rm(oracleDst, { force: true });

  const { stdout: status } = await exec('git', ['status', '--porcelain', 'demo-repo'], {
    cwd: path.resolve(demo, '..'),
  });
  const touched = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  const allowed = task.allowedPaths.map((p) => `demo-repo/${p}`);
  out.touched_files = touched;
  out.scope_ok = touched.every((f) => allowed.includes(f));
  return out;
}

async function resetWorktree(demo) {
  await exec('git', ['checkout', '--', '.'], { cwd: demo }).catch(() => {});
  await exec('git', ['clean', '-fd', 'src', 'tests'], { cwd: demo }).catch(() => {});
}

// ---------------------------------------------------------------- history padding

function padHistory(history, targetTokens) {
  const filler = [
    'We also spent a while on the changelog wording and settled on present tense.',
    'The staging box was rebooted; nothing in the app changed.',
    'Renamed a few internal variables for readability, no behaviour change.',
    'Discussed whether to split the README; decided against it for now.',
    'Tried a different terminal theme, went back to the old one.',
  ];
  let out = history;
  let i = 0;
  const target = targetTokens * 4; // chars
  while (out.length < target) {
    out += `\n\n**[agent] filler-${i}** — ${filler[i % filler.length]}`;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- main

async function runArm() {
  const arm = flag('arm');
  if (!['A', 'B', 'C'].includes(arm)) throw new Error('--arm must be A, B or C');
  const historyTokens = Number(flag('history-tokens', '8000'));
  const only = flag('tasks')?.split(',');
  const runId = randomUUID();

  const rawHistory = await fs.readFile(path.join(HERE, 'seed-history.md'), 'utf8');
  const history = padHistory(rawHistory, historyTokens);
  const tasks = ALL_TASKS.filter((t) => !only || only.includes(t.id));

  await fs.mkdir(RESULTS, { recursive: true });
  const outPath = path.join(RESULTS, `${arm}-${historyTokens}-${runId.slice(0, 8)}.jsonl`);
  const write = async (row) => fs.appendFile(outPath, `${JSON.stringify(row)}\n`);

  const { dir, demo } = await makeWorktree(arm, runId);
  console.log(`arm ${arm} · history≈${historyTokens} tok · worktree ${dir}`);

  try {
    // Arm C pays extraction once for the whole run.
    let extraction = null;
    if (arm === 'C') {
      extraction = await extractItems(history, demo);
      await write({
        kind: 'extraction', run_id: runId, arm, history_tokens: historyTokens,
        item_count: extraction.items.length, usage: extraction.usage,
        wall_clock_ms: extraction.wall_clock_ms,
      });
      console.log(`  extraction: ${extraction.items.length} items`);
    }

    for (const task of tasks) {
      const contract = contractOf(task, commonAcceptance);
      let context = '';
      let mainUsage = { ...ZERO };
      let selected = null;

      if (arm === 'B') {
        const brief = await mainAuthoredBrief(task, history, demo);
        context = brief.text;
        mainUsage = brief.usage;
      } else if (arm === 'C') {
        selected = selectItems(extraction.items, task);
        context = renderItems(selected.chosen);
      }

      const childPrompt = [
        'You are a subagent. Complete the task below in this repository.',
        'You have no access to any prior conversation. Do not ask questions.',
        'Write the file and stop. Do not write tests.',
        '',
        context ? `${context}\n` : '',
        contract,
      ].join('\n');

      const child = await callClaude(childPrompt, demo, { allowWrite: true });
      const firstPass = await verify(demo, task);

      // One repair round, given only the failure output — the cost an uninformed child imposes.
      let repair = null;
      let afterRepair = null;
      if (!(firstPass.checks_passed && firstPass.typecheck_passed)) {
        repair = await callClaude(
          [
            'Your previous change failed its checks. Fix it. Same allowed paths.',
            '',
            '--- FAILURE OUTPUT ---',
            firstPass.check_output,
          ].join('\n'),
          demo,
          { allowWrite: true },
        );
        afterRepair = await verify(demo, task);
      }

      const total = [mainUsage, child.usage, repair?.usage ?? ZERO].reduce(addUsage, ZERO);
      await write({
        kind: 'task', run_id: runId, arm, task: task.id, history_tokens: historyTokens,
        context_chars: context.length,
        selected_item_ids: selected?.chosen.map((i) => i.id) ?? null,
        main_usage: mainUsage, child_usage: child.usage, repair_usage: repair?.usage ?? null,
        total_usage: total,
        check_passed_first: Boolean(firstPass.checks_passed && firstPass.typecheck_passed),
        check_passed_after_repair: afterRepair
          ? Boolean(afterRepair.checks_passed && afterRepair.typecheck_passed)
          : null,
        repair_rounds: repair ? 1 : 0,
        scope_ok: (afterRepair ?? firstPass).scope_ok,
        touched_files: (afterRepair ?? firstPass).touched_files,
        wall_clock_ms: child.wall_clock_ms + (repair?.wall_clock_ms ?? 0),
        child_failure: child.failure,
      });

      const mark = (afterRepair ?? firstPass).checks_passed ? 'pass' : 'FAIL';
      console.log(`  ${task.id} ${mark}${repair ? ' (after repair)' : ''}`);
      await resetWorktree(demo);
    }
  } finally {
    await dropWorktree(dir);
  }
  console.log(`\nwrote ${outPath}`);
}

async function report() {
  const files = await fs.readdir(RESULTS).catch(() => []);
  const rows = [];
  for (const f of files.filter((f) => f.endsWith('.jsonl'))) {
    const text = await fs.readFile(path.join(RESULTS, f), 'utf8');
    for (const line of text.split('\n').filter(Boolean)) rows.push(JSON.parse(line));
  }
  if (rows.length === 0) return console.log('no results yet');

  const byArm = new Map();
  for (const r of rows) {
    const k = `${r.arm}@${r.history_tokens}`;
    if (!byArm.has(k)) {
      byArm.set(k, { tasks: 0, firstPass: 0, eventual: 0, repairs: 0, out: 0, inUncached: 0, unknown: 0, extractionOut: 0 });
    }
    const a = byArm.get(k);
    if (r.kind === 'extraction') {
      if (isNum(r.usage.output)) a.extractionOut += r.usage.output;
      else a.unknown++;
      continue;
    }
    a.tasks++;
    if (r.check_passed_first) a.firstPass++;
    if (r.check_passed_first || r.check_passed_after_repair) a.eventual++;
    a.repairs += r.repair_rounds;
    for (const u of [r.main_usage, r.child_usage, r.repair_usage].filter(Boolean)) {
      if (isNum(u.output)) a.out += u.output; else a.unknown++;
      if (isNum(u.input_uncached)) a.inUncached += u.input_uncached; else a.unknown++;
    }
  }

  console.log('\narm@history   tasks  1st-pass  eventual  repairs   out-tok  in-uncached  extract-tok  unknown');
  for (const [k, a] of [...byArm].sort()) {
    console.log(
      `${k.padEnd(13)} ${String(a.tasks).padStart(5)} ${String(a.firstPass).padStart(9)} ` +
      `${String(a.eventual).padStart(9)} ${String(a.repairs).padStart(8)} ` +
      `${String(a.out).padStart(9)} ${String(a.inUncached).padStart(12)} ` +
      `${String(a.extractionOut).padStart(12)} ${String(a.unknown).padStart(8)}`,
    );
  }
  console.log('\nCost per PASSED task is the headline number; unknown>0 means a usage field');
  console.log('was not recognised — fix parseUsage() rather than reading these as zero.');
}

await (has('report') ? report() : runArm());
