#!/usr/bin/env node
/**
 * Export one fully joined row per delegation, so the delegation-cost question can be
 * analysed without re-deriving anything from raw logs.
 *
 *   node asis/export-dataset.mjs --discover "C:/Users/User/.claude/projects"
 *   node asis/export-dataset.mjs <parent-session.jsonl>
 *
 * Joins three sources per session:
 *   <session>.jsonl                     what the main agent sent  (Agent tool_use blocks)
 *   <session>/subagents/*.meta.json     the link                  (toolUseId, description)
 *   <session>/subagents/*.jsonl         what the child then did   (usage, tools, output)
 *
 * Writes into --out-dir (default asis/data):
 *   delegations.jsonl   one row per delegation across every session
 *   summary.json        aggregates, per session and per task group
 *   prompts/<id>.txt    each brief as plain text
 *   reports/<id>.txt    each child's final message
 *
 * Output is real session data from real projects: kept out of git (see .gitignore).
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = (name) =>
  process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : null;

const outDir = arg('out-dir')
  ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'data');

/**
 * Delegations are easy to under-collect: a session only has children if a `subagents/`
 * directory sits beside it, and that is not visible from the parent file's own name or
 * from grepping the parent for tool calls. `--discover` walks the projects root and takes
 * every session that has one, so the dataset is not silently limited to whichever session
 * someone happened to look at first.
 */
function discoverSessions(projectsRoot) {
  const found = [];
  for (const project of fs.readdirSync(projectsRoot)) {
    const pdir = path.join(projectsRoot, project);
    let stat;
    try { stat = fs.statSync(pdir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(pdir)) {
      const sub = path.join(pdir, entry, 'subagents');
      const parent = path.join(pdir, `${entry}.jsonl`);
      if (fs.existsSync(sub) && fs.existsSync(parent)) found.push({ project, session: entry, parent, sub });
    }
  }
  return found;
}

const discoverRoot = arg('discover');
const single = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
if (!discoverRoot && !single) {
  console.error('usage: node asis/export-dataset.mjs --discover <projects-root> [--out-dir DIR]');
  console.error('       node asis/export-dataset.mjs <parent-session.jsonl> [--out-dir DIR]');
  process.exit(2);
}

const sessions = discoverRoot
  ? discoverSessions(discoverRoot)
  : [{
      project: path.basename(path.dirname(single)),
      session: path.basename(single, '.jsonl'),
      parent: single,
      sub: path.join(path.dirname(single), path.basename(single, '.jsonl'), 'subagents'),
    }];

const readJsonl = (f) =>
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

// ---------------------------------------------------------------- child transcript

function readChild(transcript) {
  const rows = readJsonl(transcript);
  const usage = { input_uncached: 0, input_cache_read: 0, input_cache_write: 0, output: 0 };
  const tools = new Map();
  const filesWritten = new Set();
  let turns = 0;
  let toolErrors = 0;
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
      if (b?.type === 'tool_result' && b?.is_error) toolErrors++;
      if (b?.type === 'text' && r?.message?.role === 'assistant') lastAssistantText = b.text ?? '';
    }
  }

  return {
    usage,
    turns,
    tool_calls: [...tools.values()].reduce((a, b) => a + b, 0),
    tools: Object.fromEntries([...tools].sort((a, b) => b[1] - a[1])),
    tool_errors: toolErrors,
    files_written: [...filesWritten],
    final_message: lastAssistantText,
    started_at: firstTs,
    ended_at: lastTs,
    duration_s: firstTs && lastTs ? Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 1000) : null,
    transcript_bytes: fs.statSync(transcript).size,
    transcript_lines: rows.length,
  };
}

// ---------------------------------------------------------------- one session

function exportSession({ project, session, parent, sub }) {
  const parentLines = fs.readFileSync(parent, 'utf8').split('\n').filter(Boolean);
  const compactionAt = [];
  parentLines.forEach((l, i) => {
    if (/isCompactSummary|compact_boundary/.test(l)) compactionAt.push(i + 1);
  });

  const sent = new Map();
  readJsonl(parent).forEach((row, idx) => {
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

  /**
   * Older meta files carry no `toolUseId`, so the join falls back to `description`.
   * Duplicated descriptions — a re-delegated task — pair in order, and each parent entry
   * is consumed once so a retry never joins to the same brief twice. `join_key` is
   * recorded per row: a degraded join must be visible in the data rather than showing up
   * as an unexplained zero.
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
    if (candidates.length === 0) return { join_key: 'unmatched', prompt: '' };
    consumed.add(candidates[0].id);
    return { ...candidates[0], join_key: 'description' };
  };

  const rows = [];
  for (const f of fs.readdirSync(sub).filter((f) => f.endsWith('.meta.json'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(sub, f), 'utf8'));
    const transcript = path.join(sub, f.replace('.meta.json', '.jsonl'));
    if (!fs.existsSync(transcript)) continue;
    const s = joinToParent(meta);
    const child = readChild(transcript);
    const briefChars = (s.prompt ?? '').length;
    const nonCacheRead = child.usage.input_uncached + child.usage.input_cache_write + child.usage.output;

    rows.push({
      project,
      session,
      agent_id: f.replace('.meta.json', ''),
      tool_use_id: meta.toolUseId ?? null,
      order: s.order ?? null,
      description: meta.description ?? s.description ?? null,
      agent_type: meta.agentType ?? s.subagent_type ?? null,
      join_key: s.join_key,
      spawn_depth: meta.spawnDepth ?? null,
      sent_at: s.timestamp ?? null,
      after_compaction: compactionAt.length > 0 && (s.row_index ?? 0) > compactionAt[0],

      brief_chars: briefChars,
      brief_tokens_est: Math.round(briefChars / 4),
      brief: s.prompt ?? '',

      child_turns: child.turns,
      child_tool_calls: child.tool_calls,
      child_tools: child.tools,
      child_tool_errors: child.tool_errors,
      child_files_written: child.files_written,
      child_usage: child.usage,
      child_non_cache_read: nonCacheRead,
      child_duration_s: child.duration_s,
      child_transcript_bytes: child.transcript_bytes,
      child_transcript_lines: child.transcript_lines,
      child_final_message: child.final_message,

      brief_share_of_footprint:
        briefChars > 0 ? Number((briefChars / 4 / (briefChars / 4 + nonCacheRead)).toFixed(4)) : null,
    });
  }
  rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const parentAgentCalls = sent.size;
  return {
    rows,
    audit: {
      project,
      session,
      parent_lines: parentLines.length,
      compaction_at_lines: compactionAt,
      parent_agent_tool_calls: parentAgentCalls,
      child_transcripts: rows.length,
      joined_by_tool_use_id: rows.filter((r) => r.join_key === 'toolUseId').length,
      joined_by_description: rows.filter((r) => r.join_key === 'description').length,
      unmatched: rows.filter((r) => r.join_key === 'unmatched').length,
      parent_calls_without_child: parentAgentCalls - consumed.size,
      rows_with_empty_brief: rows.filter((r) => r.brief_chars === 0).length,
      rows_with_zero_turns: rows.filter((r) => r.child_turns === 0).length,
      rows_with_empty_final_message: rows.filter((r) => !r.child_final_message).length,
    },
  };
}

// ---------------------------------------------------------------- run

const all = [];
const audits = [];
for (const s of sessions) {
  const { rows, audit } = exportSession(s);
  all.push(...rows);
  audits.push(audit);
}

fs.mkdirSync(path.join(outDir, 'prompts'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'reports'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'delegations.jsonl'), all.map((r) => JSON.stringify(r)).join('\n') + '\n');

const slug = (r) =>
  `${r.session.slice(0, 8)}-${String(r.order ?? 0).padStart(2, '0')}-` +
  `${(r.description ?? 'untitled').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55)}`;
for (const r of all) {
  fs.writeFileSync(path.join(outDir, 'prompts', `${slug(r)}.txt`), r.brief);
  fs.writeFileSync(path.join(outDir, 'reports', `${slug(r)}.txt`), r.child_final_message ?? '');
}

const groupOf = (d = '') =>
  d.startsWith('Run benchmark') ? 'benchmark'
  : /Contract test|contract test/i.test(d) ? 'contract-test'
  : /^QA verify/i.test(d) ? 'qa'
  : 'other';

const agg = {};
for (const r of all) {
  const g = groupOf(r.description ?? '');
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
for (const r of all) {
  const k = `${r.session.slice(0, 8)} · ${r.description}`;
  dupes[k] = (dupes[k] ?? 0) + 1;
}

fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  sessions: audits,
  totals: {
    sessions: audits.length,
    delegations: all.length,
    parent_agent_tool_calls: audits.reduce((a, s) => a + s.parent_agent_tool_calls, 0),
    unmatched: audits.reduce((a, s) => a + s.unmatched, 0),
    parent_calls_without_child: audits.reduce((a, s) => a + s.parent_calls_without_child, 0),
  },
  re_delegated: Object.fromEntries(Object.entries(dupes).filter(([, n]) => n > 1)),
  by_group: agg,
}, null, 2));

// ---------------------------------------------------------------- integrity report

console.log('project                          session    parent  agent-calls  children  byId  byDesc  unmatched  no-child');
for (const a of audits) {
  console.log(
    `${a.project.slice(0, 32).padEnd(32)} ${a.session.slice(0, 8)} ${String(a.parent_lines).padStart(8)} ` +
    `${String(a.parent_agent_tool_calls).padStart(12)} ${String(a.child_transcripts).padStart(9)} ` +
    `${String(a.joined_by_tool_use_id).padStart(5)} ${String(a.joined_by_description).padStart(7)} ` +
    `${String(a.unmatched).padStart(10)} ${String(a.parent_calls_without_child).padStart(9)}`,
  );
}

const problems = [];
for (const a of audits) {
  if (a.unmatched) problems.push(`${a.session.slice(0, 8)}: ${a.unmatched} child transcript(s) matched no parent call`);
  if (a.parent_calls_without_child) problems.push(`${a.session.slice(0, 8)}: ${a.parent_calls_without_child} parent Agent call(s) have no child transcript`);
  if (a.rows_with_empty_brief) problems.push(`${a.session.slice(0, 8)}: ${a.rows_with_empty_brief} row(s) have an empty brief`);
  if (a.rows_with_zero_turns) problems.push(`${a.session.slice(0, 8)}: ${a.rows_with_zero_turns} child(ren) recorded zero turns`);
  if (a.rows_with_empty_final_message) problems.push(`${a.session.slice(0, 8)}: ${a.rows_with_empty_final_message} child(ren) have an empty final message`);
}

console.log(`\ntotal ${all.length} delegations across ${audits.length} sessions → ${outDir}`);
console.log('\ngroup           n   brief/deleg   child-non-cache-read/deleg   brief share');
for (const [g, a] of Object.entries(agg).sort((x, y) => y[1].n - x[1].n)) {
  console.log(
    `${g.padEnd(14)} ${String(a.n).padStart(2)} ${String(a.brief_tokens_per_delegation).padStart(13)} ` +
    `${String(a.child_non_cache_read_per_delegation).padStart(28)} ${(a.brief_share * 100).toFixed(1).padStart(11)}%`,
  );
}

if (problems.length) {
  console.log('\nINTEGRITY:');
  for (const p of problems) console.log(`  ! ${p}`);
} else {
  console.log('\nINTEGRITY: clean — every child joined to a brief, every parent call has a child.');
}
