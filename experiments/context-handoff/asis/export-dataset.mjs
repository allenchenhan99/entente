#!/usr/bin/env node
/**
 * Export one fully joined row per delegation, so the delegation-cost question can be
 * analysed without re-deriving anything from raw logs.
 *
 *   node asis/export-dataset.mjs <parent-session.jsonl> [--out-dir asis/data]
 *
 * Joins three sources:
 *   parent .jsonl                       what the main agent sent  (Agent tool_use blocks)
 *   <session>/subagents/*.meta.json     the link                  (toolUseId)
 *   <session>/subagents/*.jsonl         what the child then did   (usage, tools, output)
 *
 * Writes:
 *   delegations.jsonl   one row per delegation, full prompt + full child accounting
 *   summary.json        aggregates
 *   prompts/<id>.txt    each brief as plain text, for reading
 *   reports/<id>.txt    each child's final message, for reading
 *
 * Output is session data from a real project: kept out of git (see .gitignore).
 */
import fs from 'node:fs';
import path from 'node:path';

const parentFile = process.argv[2];
if (!parentFile) {
  console.error('usage: node asis/export-dataset.mjs <parent-session.jsonl> [--out-dir DIR]');
  process.exit(2);
}
const outDir = process.argv.includes('--out-dir')
  ? process.argv[process.argv.indexOf('--out-dir') + 1]
  : path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'data');

const subagentDir = path.join(
  path.dirname(parentFile),
  path.basename(parentFile, '.jsonl'),
  'subagents',
);

const readJsonl = (f) =>
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

// ---------------------------------------------------------------- parent side

const parentRows = readJsonl(parentFile);
const parentLines = fs.readFileSync(parentFile, 'utf8').split('\n').filter(Boolean);
const compactionAt = [];
parentLines.forEach((l, i) => {
  if (/isCompactSummary|compact_boundary/.test(l)) compactionAt.push(i + 1);
});

const sent = new Map(); // toolUseId -> what the main agent sent
parentRows.forEach((row, idx) => {
  const content = row?.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (b?.type === 'tool_use' && b?.name === 'Agent') {
      sent.set(b.id, {
        order: sent.size + 1,
        row_index: idx,
        timestamp: row.timestamp ?? null,
        description: b.input?.description ?? null,
        subagent_type: b.input?.subagent_type ?? null,
        prompt: b.input?.prompt ?? '',
      });
    }
  }
});

// ---------------------------------------------------------------- child side

function readChild(transcript) {
  const rows = readJsonl(transcript);
  const usage = { input_uncached: 0, input_cache_read: 0, input_cache_write: 0, output: 0 };
  const tools = new Map();
  const filesWritten = new Set();
  let turns = 0;
  let errors = 0;
  let lastAssistantText = '';
  let firstTs = null;
  let lastTs = null;

  for (const r of rows) {
    if (r.timestamp) {
      firstTs ??= r.timestamp;
      lastTs = r.timestamp;
    }
    const u = r?.message?.usage;
    if (u) {
      usage.input_uncached += u.input_tokens ?? 0;
      usage.input_cache_read += u.cache_read_input_tokens ?? 0;
      usage.input_cache_write += u.cache_creation_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      turns++;
    }
    const content = r?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use') {
        tools.set(b.name, (tools.get(b.name) ?? 0) + 1);
        const p = b.input?.file_path ?? b.input?.path;
        if (p && /^(Write|Edit|NotebookEdit)$/.test(b.name)) filesWritten.add(p);
      }
      if (b?.type === 'tool_result' && b?.is_error) errors++;
      if (b?.type === 'text' && r?.message?.role === 'assistant') lastAssistantText = b.text ?? '';
    }
  }

  return {
    usage,
    turns,
    tool_calls: [...tools.values()].reduce((a, b) => a + b, 0),
    tools: Object.fromEntries([...tools].sort((a, b) => b[1] - a[1])),
    tool_errors: errors,
    files_written: [...filesWritten],
    final_message: lastAssistantText,
    started_at: firstTs,
    ended_at: lastTs,
    duration_s: firstTs && lastTs ? Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 1000) : null,
    transcript_bytes: fs.statSync(transcript).size,
  };
}

// ---------------------------------------------------------------- join

/**
 * Older meta files carry no `toolUseId` (15 of 36 in the reference session), so the join
 * falls back to `description`. Duplicated descriptions — a re-delegated task — are paired
 * in order, and each parent entry is consumed once so a retry never joins to the same
 * brief twice. `join_key` records which path was used, so a silently degraded join is
 * visible in the data rather than showing up as a mysterious zero.
 */
const byDescription = new Map();
for (const [id, s] of sent) {
  const k = s.description ?? '';
  if (!byDescription.has(k)) byDescription.set(k, []);
  byDescription.get(k).push({ id, ...s });
}
const consumed = new Set();
const joinToParent = (meta) => {
  if (meta.toolUseId && sent.has(meta.toolUseId)) {
    consumed.add(meta.toolUseId);
    return { ...sent.get(meta.toolUseId), join_key: 'toolUseId' };
  }
  const candidates = (byDescription.get(meta.description ?? '') ?? []).filter((c) => !consumed.has(c.id));
  if (candidates.length === 0) return { join_key: 'unmatched' };
  consumed.add(candidates[0].id);
  return { ...candidates[0], join_key: 'description' };
};

const rows = [];
for (const f of fs.readdirSync(subagentDir).filter((f) => f.endsWith('.meta.json'))) {
  const meta = JSON.parse(fs.readFileSync(path.join(subagentDir, f), 'utf8'));
  const transcript = path.join(subagentDir, f.replace('.meta.json', '.jsonl'));
  if (!fs.existsSync(transcript)) continue;
  const s = joinToParent(meta);
  const child = readChild(transcript);
  const promptChars = (s.prompt ?? '').length;

  rows.push({
    agent_id: f.replace('.meta.json', ''),
    tool_use_id: meta.toolUseId,
    order: s.order ?? null,
    description: meta.description ?? s.description ?? null,
    agent_type: meta.agentType ?? s.subagent_type ?? null,
    join_key: s.join_key,
    spawn_depth: meta.spawnDepth ?? null,
    sent_at: s.timestamp ?? null,
    after_compaction: compactionAt.length > 0 && (s.row_index ?? 0) > compactionAt[0],

    brief_chars: promptChars,
    brief_tokens_est: Math.round(promptChars / 4),
    brief: s.prompt ?? '',

    child_turns: child.turns,
    child_tool_calls: child.tool_calls,
    child_tools: child.tools,
    child_tool_errors: child.tool_errors,
    child_files_written: child.files_written,
    child_usage: child.usage,
    child_non_cache_read: child.usage.input_uncached + child.usage.input_cache_write + child.usage.output,
    child_duration_s: child.duration_s,
    child_transcript_bytes: child.transcript_bytes,
    child_final_message: child.final_message,

    brief_share_of_footprint:
      promptChars > 0
        ? Number((promptChars / 4 / (promptChars / 4 + child.usage.input_uncached + child.usage.input_cache_write + child.usage.output)).toFixed(4))
        : null,
  });
}
rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

// ---------------------------------------------------------------- write

fs.mkdirSync(path.join(outDir, 'prompts'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'reports'), { recursive: true });

fs.writeFileSync(
  path.join(outDir, 'delegations.jsonl'),
  rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
);

const slug = (r) =>
  `${String(r.order ?? 0).padStart(2, '0')}-${(r.description ?? 'untitled')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`;

for (const r of rows) {
  fs.writeFileSync(path.join(outDir, 'prompts', `${slug(r)}.txt`), r.brief);
  fs.writeFileSync(path.join(outDir, 'reports', `${slug(r)}.txt`), r.child_final_message ?? '');
}

const groupOf = (d = '') =>
  d.startsWith('Run benchmark') ? 'benchmark'
  : /Contract test/i.test(d) ? 'contract-test'
  : /^QA verify/i.test(d) ? 'qa'
  : 'other';

const agg = {};
for (const r of rows) {
  const g = groupOf(r.description);
  agg[g] ??= { n: 0, brief_tokens: 0, child_output: 0, child_uncached: 0, child_cache_write: 0, child_cache_read: 0, turns: 0, tool_calls: 0, tool_errors: 0, duration_s: 0 };
  const a = agg[g];
  a.n++;
  a.brief_tokens += r.brief_tokens_est;
  a.child_output += r.child_usage.output;
  a.child_uncached += r.child_usage.input_uncached;
  a.child_cache_write += r.child_usage.input_cache_write;
  a.child_cache_read += r.child_usage.input_cache_read;
  a.turns += r.child_turns;
  a.tool_calls += r.child_tool_calls;
  a.tool_errors += r.child_tool_errors;
  a.duration_s += r.child_duration_s ?? 0;
}
for (const a of Object.values(agg)) {
  a.brief_tokens_per_delegation = Math.round(a.brief_tokens / a.n);
  a.child_non_cache_read_per_delegation = Math.round((a.child_output + a.child_uncached + a.child_cache_write) / a.n);
  a.brief_share = Number((a.brief_tokens / (a.brief_tokens + a.child_output + a.child_uncached + a.child_cache_write)).toFixed(4));
}

const dupes = {};
for (const r of rows) dupes[r.description] = (dupes[r.description] ?? 0) + 1;

fs.writeFileSync(
  path.join(outDir, 'summary.json'),
  JSON.stringify({
    parent_session: path.basename(parentFile),
    parent_lines: parentLines.length,
    compaction_at_lines: compactionAt,
    delegations: rows.length,
    delegations_after_compaction: rows.filter((r) => r.after_compaction).length,
    re_delegated: Object.fromEntries(Object.entries(dupes).filter(([, n]) => n > 1)),
    by_group: agg,
  }, null, 2),
);

console.log(`delegations   ${rows.length}`);
console.log(`out           ${outDir}`);
console.log(`              delegations.jsonl  (one joined row each)`);
console.log(`              summary.json`);
console.log(`              prompts/  ${rows.length} files`);
console.log(`              reports/  ${rows.length} files`);
console.log('\ngroup           n   brief/deleg   child-non-cache-read/deleg   brief share');
for (const [g, a] of Object.entries(agg)) {
  console.log(
    `${g.padEnd(14)} ${String(a.n).padStart(2)} ${String(a.brief_tokens_per_delegation).padStart(13)} ` +
    `${String(a.child_non_cache_read_per_delegation).padStart(28)} ${(a.brief_share * 100).toFixed(1).padStart(11)}%`,
  );
}
