#!/usr/bin/env node
// Prints one row per run under <out>/<date>/*/run.json (default /tmp/entente-r2/<today>) and writes results.json.
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2] ?? path.join('/tmp/entente-r2', new Date().toISOString().slice(0, 10));
const rows = [];
for (const dir of fs.readdirSync(root)) {
  const f = path.join(root, dir, 'run.json');
  if (!fs.existsSync(f)) continue;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  const v = r.verification ?? {};
  const u = r.usage ?? {};
  rows.push({
    case: r.case, arm: r.arm, run: r.run, decision: r.decision ?? '-',
    seconds: Math.round((r.elapsed_ms ?? 0) / 1000),
    artifact: r.artifact_success === true, oracle: v.oracle?.ok ?? null, typecheck: v.typecheck?.ok ?? null,
    scope_violations: v.disallowed_paths?.length ?? null, leaks: v.leaks?.length ?? null,
    questions: (r.clarifications ?? []).reduce((n, c) => n + c.questions.length, 0) + (r.mission_clarifications ?? []).reduce((n, c) => n + c.questions.length, 0),
    terminal: r.terminal_event?.type ?? (r.arm === 'native' ? `exit ${r.exit_code}` : 'timeout'),
    input_tokens: u.input_tokens ?? null, uncached: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), output_tokens: u.output_tokens ?? null,
  });
}
rows.sort((a, b) => a.case.localeCompare(b.case) || a.arm.localeCompare(b.arm) || a.run - b.run);
const cols = ['case', 'arm', 'run', 'decision', 'seconds', 'artifact', 'oracle', 'typecheck', 'scope_violations', 'leaks', 'questions', 'terminal', 'input_tokens', 'uncached', 'output_tokens'];
console.log(cols.join('\t'));
for (const r of rows) console.log(cols.map((c) => String(r[c])).join('\t'));
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
