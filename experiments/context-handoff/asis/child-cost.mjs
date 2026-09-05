#!/usr/bin/env node
/**
 * AS-IS part 2: what the children actually cost.
 *
 * Claude Code persists each subagent's full transcript next to the parent session:
 *
 *   projects/<encoded-cwd>/<parent-session-id>/subagents/agent-<id>.jsonl
 *   projects/<encoded-cwd>/<parent-session-id>/subagents/agent-<id>.meta.json
 *
 * The meta carries `toolUseId`, which joins back to the parent's Agent tool_use block, so
 * "what the main agent sent" and "what the child then spent" can be measured as one row.
 *
 *   node asis/child-cost.mjs <parent-session.jsonl>
 *
 * Usage is read from each assistant message's own `usage` object. Cached and uncached
 * input are kept apart and never summed into a single "input" figure.
 */
import fs from 'node:fs';
import path from 'node:path';

const parentFile = process.argv[2];
if (!parentFile) {
  console.error('usage: node asis/child-cost.mjs <parent-session.jsonl>');
  process.exit(2);
}
const subagentDir = path.join(
  path.dirname(parentFile),
  path.basename(parentFile, '.jsonl'),
  'subagents',
);

// ---------------------------------------------------------------- parent side

const delegationsByToolUseId = new Map();
for (const line of fs.readFileSync(parentFile, 'utf8').split('\n').filter(Boolean)) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  const content = row?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const b of content) {
    if (b?.type === 'tool_use' && b?.name === 'Agent') {
      delegationsByToolUseId.set(b.id, {
        description: b.input?.description ?? '-',
        promptChars: (b.input?.prompt ?? '').length,
      });
    }
  }
}

// ---------------------------------------------------------------- child side

const sum = (a, b) => ({
  in_uncached: a.in_uncached + b.in_uncached,
  in_cache_read: a.in_cache_read + b.in_cache_read,
  in_cache_write: a.in_cache_write + b.in_cache_write,
  out: a.out + b.out,
  turns: a.turns + b.turns,
});
const ZERO = { in_uncached: 0, in_cache_read: 0, in_cache_write: 0, out: 0, turns: 0 };

function childUsage(file) {
  let total = { ...ZERO };
  let toolCalls = 0;
  let reads = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const u = row?.message?.usage;
    if (u) {
      total = sum(total, {
        in_uncached: u.input_tokens ?? 0,
        in_cache_read: u.cache_read_input_tokens ?? 0,
        in_cache_write: u.cache_creation_input_tokens ?? 0,
        out: u.output_tokens ?? 0,
        turns: 1,
      });
    }
    const content = row?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') {
          toolCalls++;
          if (b.name === 'Read' || b.name === 'Grep' || b.name === 'Glob') reads++;
        }
      }
    }
  }
  return { ...total, toolCalls, reads };
}

const rows = [];
for (const f of fs.readdirSync(subagentDir).filter((f) => f.endsWith('.meta.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(subagentDir, f), 'utf8'));
  const transcript = path.join(subagentDir, f.replace('.meta.json', '.jsonl'));
  if (!fs.existsSync(transcript)) continue;
  const parent = delegationsByToolUseId.get(meta.toolUseId) ?? {};
  rows.push({
    description: meta.description ?? parent.description ?? '-',
    agentType: meta.agentType,
    spawnDepth: meta.spawnDepth,
    promptChars: parent.promptChars ?? null,
    ...childUsage(transcript),
  });
}

// ---------------------------------------------------------------- report

const group = (d) =>
  d.startsWith('Run benchmark') ? 'benchmark runs'
  : /Contract test/i.test(d) ? 'contract tests'
  : /^QA verify/i.test(d) ? 'QA verification'
  : 'other';

const byGroup = new Map();
for (const r of rows) {
  const g = group(r.description);
  if (!byGroup.has(g)) byGroup.set(g, []);
  byGroup.get(g).push(r);
}

console.log(`parent    ${path.basename(parentFile)}`);
console.log(`children  ${rows.length} transcripts joined by toolUseId\n`);

console.log('group             n   brief-ch   child-out   child-in-uncached   cache-read   turns   tools');
let grand = { ...ZERO, toolCalls: 0, promptChars: 0 };
for (const [g, rs] of byGroup) {
  const t = rs.reduce((a, r) => ({
    ...sum(a, r),
    toolCalls: a.toolCalls + r.toolCalls,
    promptChars: a.promptChars + (r.promptChars ?? 0),
  }), { ...ZERO, toolCalls: 0, promptChars: 0 });
  grand = { ...sum(grand, t), toolCalls: grand.toolCalls + t.toolCalls, promptChars: grand.promptChars + t.promptChars };
  console.log(
    `${g.padEnd(16)} ${String(rs.length).padStart(2)} ${String(t.promptChars).padStart(10)} ` +
    `${String(t.out).padStart(11)} ${String(t.in_uncached).padStart(19)} ` +
    `${String(t.in_cache_read).padStart(12)} ${String(t.turns).padStart(7)} ${String(t.toolCalls).padStart(7)}`,
  );
}
console.log(
  `${'TOTAL'.padEnd(16)} ${String(rows.length).padStart(2)} ${String(grand.promptChars).padStart(10)} ` +
  `${String(grand.out).padStart(11)} ${String(grand.in_uncached).padStart(19)} ` +
  `${String(grand.in_cache_read).padStart(12)} ${String(grand.turns).padStart(7)} ${String(grand.toolCalls).padStart(7)}`,
);

const bench = byGroup.get('benchmark runs') ?? [];
if (bench.length) {
  const briefTokens = Math.round(bench.reduce((a, r) => a + (r.promptChars ?? 0), 0) / 4);
  const childOut = bench.reduce((a, r) => a + r.out, 0);
  const childIn = bench.reduce((a, r) => a + r.in_uncached + r.in_cache_write, 0);
  console.log(`\nbenchmark group, per delegation (n=${bench.length}):`);
  console.log(`  brief the main agent wrote   ~${Math.round(briefTokens / bench.length)} tok   (total ~${briefTokens})`);
  console.log(`  child output                 ~${Math.round(childOut / bench.length)} tok   (total ${childOut})`);
  console.log(`  child input, non-cache-read  ~${Math.round(childIn / bench.length)} tok   (total ${childIn})`);
  console.log(`  the brief is ${((briefTokens / (briefTokens + childOut + childIn)) * 100).toFixed(1)}% of the delegation's own token footprint`);
}
