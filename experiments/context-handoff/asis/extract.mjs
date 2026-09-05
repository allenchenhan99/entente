#!/usr/bin/env node
/**
 * AS-IS measurement: what does hand-written delegation actually cost today?
 *
 * Reads a Claude Code session log and reports, per delegation, what the main agent
 * hand-wrote and how much of it was the same standing facts restated. Produces the
 * numbers in FINDINGS.md.
 *
 *   node asis/extract.mjs <session.jsonl> [--json out.jsonl]
 *
 * Default session (the one FINDINGS.md is written from):
 *   C:/Users/User/.claude/projects/D--vscode-python-unvisited/84912a87-292d-4007-8e84-e099d45205a2.jsonl
 *
 * Session logs are personal and large; they are not vendored into this repo. Re-point
 * this at any session with delegations to reproduce the shape of the finding.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node asis/extract.mjs <session.jsonl> [--json out.jsonl]');
  process.exit(2);
}
const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null;

// ---------------------------------------------------------------- read

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const delegations = [];
const compactionLines = [];
const agentToolUseIds = new Set();
let sidechainTrue = 0;
let sidechainFalse = 0;

lines.forEach((line, i) => {
  if (/isCompactSummary|compact_boundary/.test(line)) compactionLines.push(i + 1);
  // Count the VALUE, not the field. Matching the bare field name counts every
  // "isSidechain":false line too and inflates this by three orders of magnitude.
  if (/"isSidechain":true/.test(line)) sidechainTrue++;
  if (/"isSidechain":false/.test(line)) sidechainFalse++;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  const content = row?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_use' && block?.name === 'Agent') {
      agentToolUseIds.add(block.id);
      delegations.push({
        line: i + 1,
        description: block.input?.description ?? '-',
        subagent_type: block.input?.subagent_type ?? '-',
        prompt: block.input?.prompt ?? '',
      });
    }
  }
});

/**
 * What came back on the Agent tool call. When delegation is async this is only a launch
 * acknowledgement, NOT the child's work — so a large delegation count does not imply the
 * child's output is available for analysis. Reported explicitly so the distinction is
 * never assumed away.
 */
let childResultCount = 0;
let childResultChars = 0;
let asyncAckCount = 0;
for (const line of lines) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const content = row?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (b?.type !== 'tool_result' || !agentToolUseIds.has(b.tool_use_id)) continue;
    const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
    childResultCount++;
    childResultChars += text.length;
    if (/Async agent launched|working in the background/i.test(text)) asyncAckCount++;
  }
}

// ---------------------------------------------------------------- fact restatement
//
// The facts are matched by a marker rather than by exact string, precisely because the
// main agent paraphrases. Counting exact duplicates would UNDER-report the redundancy —
// which is the whole point of the finding.

const FACT_MARKERS = [
  ['standing decision (a tool is broken, do not use it)', /CORS/i],
  ['human instruction relayed from an earlier turn', /concise/i],
  ['evidence directory paths', /trip_com_tool_benchmark_2026-09/],
  ['an interface fact (day-count formula)', /days\s*\+\s*1|\)\.days/],
  ['accumulated findings from sibling children', /case1[14]|prior cases|reuse from case/i],
];

// ---------------------------------------------------------------- group

const groups = {
  'benchmark runs': (d) => d.description.startsWith('Run benchmark'),
  'contract tests': (d) => /Contract test/i.test(d.description),
  'QA verification': (d) => /^QA verify/i.test(d.description),
  other: () => true,
};

const classify = (d) => {
  for (const [name, fn] of Object.entries(groups)) if (fn(d)) return name;
  return 'other';
};

const lexicalOverlap = (prompts) => {
  if (prompts.length < 2) return { sharedLines: 0, sharedChars: 0 };
  const counts = new Map();
  for (const p of prompts) {
    for (const raw of new Set(p.split('\n'))) {
      const l = raw.trim();
      if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
  }
  const shared = [...counts].filter(([, n]) => n === prompts.length).map(([l]) => l);
  return { sharedLines: shared.length, sharedChars: shared.reduce((a, l) => a + l.length + 1, 0) };
};

// ---------------------------------------------------------------- report

const byGroup = new Map();
for (const d of delegations) {
  const g = classify(d);
  if (!byGroup.has(g)) byGroup.set(g, []);
  byGroup.get(g).push(d);
}

console.log(`session       ${path.basename(file)}`);
console.log(`lines         ${lines.length}`);
console.log(`delegations   ${delegations.length}`);
console.log(`sidechain     ${sidechainTrue} true / ${sidechainFalse} false`
  + (sidechainTrue === 0 ? '  → no child transcripts in this file' : ''));
console.log(`child results ${childResultCount} returned, ${asyncAckCount} of them only async launch acks`
  + (asyncAckCount === childResultCount && childResultCount > 0
    ? '  → child OUTPUT is not available here, only what was sent to them'
    : ''));
console.log(`compaction    at line(s) ${compactionLines.join(', ') || 'none'}`);
if (compactionLines.length) {
  const before = delegations.filter((d) => d.line < compactionLines[0]).length;
  console.log(`              ${before} delegations before, ${delegations.length - before} after`);
}

console.log('\ngroup              n   total chars   ~tokens   avg chars   exact-line overlap');
for (const [g, ds] of byGroup) {
  const prompts = ds.map((d) => d.prompt);
  const total = prompts.reduce((a, p) => a + p.length, 0);
  const { sharedLines, sharedChars } = lexicalOverlap(prompts);
  const pct = total ? Math.round((sharedChars * ds.length * 100) / total) : 0;
  console.log(
    `${g.padEnd(17)} ${String(ds.length).padStart(2)} ${String(total).padStart(13)} ` +
    `${String(Math.round(total / 4)).padStart(9)} ${String(Math.round(total / ds.length)).padStart(11)}   ` +
    `${sharedLines} lines / ${sharedChars} ch (${pct}%)`,
  );
}

const bench = byGroup.get('benchmark runs') ?? [];
if (bench.length) {
  console.log(`\nfact restatement across the ${bench.length} benchmark delegations:`);
  for (const [label, re] of FACT_MARKERS) {
    const n = bench.filter((d) => re.test(d.prompt)).length;
    console.log(`  ${String(n).padStart(2)}/${bench.length}  ${label}`);
  }
}

const dupes = new Map();
for (const d of delegations) dupes.set(d.description, (dupes.get(d.description) ?? 0) + 1);
const retried = [...dupes].filter(([, n]) => n > 1);
if (retried.length) {
  console.log('\nre-delegated (same description more than once):');
  for (const [desc, n] of retried) console.log(`  ${n}x  ${desc}`);
}

if (jsonOut) {
  fs.writeFileSync(jsonOut, delegations.map((d) => JSON.stringify(d)).join('\n') + '\n');
  console.log(`\nwrote ${jsonOut}`);
}
