import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const json = value => JSON.stringify(value, null, 2) + '\n';
const families = ['evidence-service', 'research-accounting'];
const names = {
  'evidence-service': ['identity', 'append', 'verify', 'select', 'review', 'integrate'],
  'research-accounting': ['usage', 'cache', 'bill', 'include', 'pair', 'report'],
};

function rules(seed, revision) {
  const n = seed % 97;
  return {
    identity: { prefix: `ev${n}`, artifactRevision: revision >= 2 },
    verification: { required: [`scope-${n}`, `behavior-${n}`], schema: revision >= 2 ? 2 : 1 },
    retrieval: { limit: 8 + n % 5 + (revision >= 3 ? 2 : 0), overhead: 2, conflictCost: 1 },
    lineage: { current: revision >= 3 ? `source-${n}-b` : `source-${n}-a`, conflict: `retention-${n}`, claims: [`board-${n}-a`, `board-${n}-b`] },
    counters: { inputIncludesCache: revision < 2, rate: 2 + n % 3, cacheRate: 1, outputRate: 5 + n % 3 },
    billing: { currency: `credit-${n}`, cap: 80 + n + (revision >= 3 ? 20 : 0), conflict: `allocation-${n}`, claims: [`finance-${n}-a`, `finance-${n}-b`], dataset: revision >= 3 ? `data-${n}-b` : `data-${n}-a` },
  };
}

function sources(family, p) {
  const common = {
    'package.json': json({ private: true, type: 'module' }),
    'README.md': `# ${family}\nImplement the assigned export in its own src module. See docs/README.md for the source register. No dependencies are needed. Inputs are read-only. Every function must leave its arguments unchanged. Later assignments may import earlier outputs. Policies can change at assignment boundaries: implementations must read current inputs at invocation or module load, rather than freeze copied policy values.\n`,
    'docs/README.md': '# Source register\nCurrent machine-readable inputs and their companion normative documents jointly define behavior. Current inputs override older values. Normative documents override legacy notes. Equally authoritative signed decisions remain unresolved: report both claim IDs in sorted order and block only the affected claim. Never use file order to choose a winner.\n\nRead identity.md, verification.md, retrieval.md and lineage.md for evidence work; counters.md, billing.md, inclusion.md and pairing.md for accounting. decisions.md records signed claims; legacy.md is historical only. Input revisions arrive at assignment boundaries.\n',
    'docs/legacy.md': '# Archived migration notes — NOT normative\nThe old service identified evidence by task alone, accepted submitter-reported passes, and truncated context strings to fit. Original accounting summed cumulative snapshots, excluded cache from input and dropped failed runs. A planning spreadsheet split shared owner work among children and quoted a total of 999 credits. These notes are retained to explain old dashboards; the source register explicitly supersedes them.\n',
  };
  if (family === 'evidence-service') return { ...common,
    'inputs/identity.json': json(p.identity), 'inputs/verification.json': json(p.verification),
    'inputs/retrieval.json': json(p.retrieval), 'inputs/lineage.json': json(p.lineage),
    'docs/identity.md': '# Identity contract\nidentity(record) returns a string joining the configured prefix, tenant, task, version and attempt with |. Encode each component with encodeURIComponent(String(value)). When artifactRevision is enabled append artifactRevision as one more encoded component. Records contain all these fields. Tenant/task may contain separators or Unicode. Versions and attempts are positive integers; artifacts have integer revisions. Never merge attempts.\n\nappend(history, record) returns {status, history}. Identity collisions return status duplicate with the original history. Otherwise return appended and a new history containing the new record at the end. Historical bytes and ordering are immutable. Use the current identity policy.\n',
    'docs/verification.md': '# Independent verification\nverify(record, checks) returns {status, missing}. record.schema must equal the current configured schema; otherwise return stale with missing []. For each configured required ID, exactly one check must exist with origin external and status passed. Extra IDs do not affect acceptance. Duplicate checks for a required ID invalidate that ID, even when both pass. missing contains invalid/absent required IDs sorted lexically. Return verified only when missing is empty; otherwise failed. A submitter claim is never external evidence.\n',
    'docs/retrieval.md': '# Bounded retrieval\nselect(records, tags, budget) returns {selected, omitted}, arrays of record IDs in consideration order. Effective budget is min(budget, configured limit); budgets/costs are nonnegative integers. Records have id (string), tags (string array), observedStep (number), tokens (nonnegative integer), status (string), and optional conflict (string). Eligible records have status === "current" and at least one exact tag overlap (count distinct matching tags); every other status is ineligible. Group eligible records with the same nonempty conflict string; other records form singleton groups. Include every eligible member or none. Group rank is maximum overlap descending, maximum observedStep descending, then smallest ID lexically. Members sort by ID. Cost is sum(tokens + overhead) plus conflictCost once for a conflicted group. Skip groups that do not fit and continue. Do not truncate or spend budget on stale records.\n',
    'docs/lineage.md': '# Delta review and final integration\nreview(delta) returns {status, conflicts}. If delta.source differs from current source, return stale with []. Otherwise if delta.claim equals the disputed claim, return unresolved with both signed claim IDs sorted. Otherwise return accepted with []. Staleness is checked before conflict.\n\nintegrate({history, record, checks, delta, records, tags, budget}) returns {identity, history, verification, review, context}. identity is the identity string, history is append(...).history, verification is verify(...), review is review(delta), context is select(...). All use current sources; accepting a delta must not replace old evidence.\n',
    'docs/decisions.md': `# Signed retention decisions\nEqual authority, neither supersedes the other. ${p.lineage.claims[0]} says ${p.lineage.conflict} allows ${10 + p.retrieval.limit} days; ${p.lineage.claims[1]} says it allows ${20 + p.retrieval.limit} days. The conflict blocks a resolved retention claim, not unrelated evidence work.\n`,
  };
  return { ...common,
    'inputs/counters.json': json(p.counters), 'inputs/billing.json': json(p.billing),
    'docs/counters.md': '# Usage ledger\nusage(samples) returns {input, cached, output, resets}. Samples are cumulative {session,input,cached,output} counters, nonnegative integers, in observation order. Maintain a previous snapshot per session. First snapshots contribute their entire counters. If ANY counter decreases, all counters for that session reset together; contribute the whole new snapshot and increment resets. Otherwise contribute componentwise deltas. Repeated snapshots contribute zero. Returned input is exactly the raw input counter total, not adjusted for cache.\n\ncache(usage) returns {uncached,cached,output,cost}, using the current counter convention and integer rates. When inputIncludesCache, uncached=input-cached; otherwise uncached=input. If uncached is negative return {status:invalid}; otherwise cost=uncached*rate+cached*cacheRate+output*outputRate. Do not bill cached tokens twice.\n',
    'docs/billing.md': '# Whole workflow charges\nbill(stages) returns {cost,stageIds}. A stage is {id,usage}; usage has input,cached,output counters already converted to deltas. Identical repeated stage IDs with identical usage are charged once, including shared owner/orientation stages. Conflicting usage for the same ID returns {status:unresolved,ids:[...]} with all conflicting IDs sorted, and no cost. An invalid cache ledger returns {status:invalid}. Otherwise sum cache(usage).cost once per ID; stageIds sort lexically. All stages are charged regardless of role.\n',
    'docs/inclusion.md': '# Incomplete sequences\ninclude(runs) returns {assigned,accepted,cappedDuration,knownCost,incompleteIds}. Each run is {id,status,duration,cost}; status is passed, failed or timeout. duration and cost are either nonnegative numbers or null. Every assigned run contributes to assigned. Only passed contributes to accepted. Passed runs with known duration contribute min(duration,cap); every other run contributes cap. Sum all known costs, including failures; never impute missing costs to zero without listing the run ID in sorted incompleteIds. Also list runs with null duration there.\n',
    'docs/pairing.md': '# Paired comparison and report\npair(rows) returns {pairs,unpaired,unresolved}. Each row is {block,arm,duration,dataset}, arm is checkpoint or baseline; duration is finite and nonnegative. Only the current dataset is eligible. For each block, exactly one eligible row per arm yields {block,delta}, delta=checkpoint.duration-baseline.duration. A duplicate eligible arm makes that block unresolved; a single arm makes it unpaired. Arrays sort by block. Ignore blocks with no eligible rows. Never pair across blocks or silently average duplicates.\n\nreport({stages,runs,rows,claim}) returns {billing,inclusion,comparison,allocation,currency,dataset}. The first three are bill(stages), include(runs), pair(rows). allocation is {status:unresolved,conflicts:[signed IDs sorted]} when claim equals the disputed allocation claim; otherwise {status:accepted,conflicts:[]}. Currency and dataset come from current billing policy. Do not fabricate an allocation for conflicting signed instructions.\n',
    'docs/decisions.md': `# Signed allocation decisions\nEqual authority. ${p.billing.claims[0]} assigns ${p.billing.conflict} to owner; ${p.billing.claims[1]} assigns it to child. Neither supersedes the other. Billing still charges actual stages once; allocation remains unresolved.\n`,
  };
}

const descriptions = {
  'evidence-service': [
    'Export identity(record), producing the canonical evidence identity string.',
    'Export append(history, record), preserving append-only attempt history and rejecting duplicate identities.',
    'Export verify(record, checks), enforcing current independent verification and schema semantics.',
    'Export select(records, tags, budget), retrieving whole relevant context groups under the current bound.',
    'Export review(delta), classifying source freshness and unresolved claims.',
    'Export integrate(request), combining identity, history, verification, delta review and bounded retrieval under current sources.',
  ],
  'research-accounting': [
    'Export usage(samples), deriving usage deltas across cumulative session snapshots and resets.',
    'Export cache(usage), separating cache categories and computing integer credit cost.',
    'Export bill(stages), billing complete workflows with shared-stage deduplication.',
    'Export include(runs), retaining incomplete and failed assignments in sequence accounting.',
    'Export pair(rows), comparing matched sequences using the current dataset.',
    'Export report(request), producing complete billing, inclusion, paired comparison and unresolved allocation results.',
  ],
};

export function buildFixture(family, seed) {
  if (!families.includes(family)) throw new TypeError('Unknown fixture family');
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError('seed must be a nonnegative safe integer');
  const files = sources(family, rules(seed, 1));
  const steps = names[family].map((name, i) => {
    const revision = i >= 4 ? 3 : i >= 2 ? 2 : 1;
    const policy = rules(seed, revision);
    const updates = {};
    if (i === 2 || i === 4) {
      const next = sources(family, policy);
      const previous = sources(family, rules(seed, revision - 1));
      for (const [file, contents] of Object.entries(next)) {
        if (contents !== previous[file]) updates[file] = contents;
      }
      updates[`docs/release-${revision}.md`] = `# Current release ${revision}\nThe accompanying input files supersede previous values. Revalidate reused facts against current sources; outputs remain in place.\n`;
    }
    return { id: `${family}-${i + 1}`, title: name, goal: `${descriptions[family][i]} Implement in src/${name}.mjs as a named synchronous export. Public source documents define exact argument/result shapes and domain rules. Do not modify inputs or other deliverables.`,
      tags: family === 'evidence-service' ? ['evidence', ...[['identity'], ['identity', 'history'], ['verification', 'identity'], ['context', 'bounds'], ['lineage', 'conflict'], ['identity', 'verification', 'context', 'lineage']][i]] : ['accounting', ...[['counters'], ['counters', 'cache'], ['cache', 'billing'], ['billing', 'inclusion'], ['pairing', 'lineage'], ['billing', 'inclusion', 'pairing', 'conflict']][i]],
      allowed_paths: [`src/${name}.mjs`], updates, oracle: { revision, cases: cases(family, i, policy) } };
  });
  return { family, seed, files, steps };
}

// These expected values are derived here, outside candidate repositories. No
// reference implementation or private input is materialized into public files.
function cases(family, step, p) {
  const out = [];
  const add = (id, args, expected) => out.push({ id, args, expected });
  if (family === 'evidence-service') {
    const r = { tenant: 'lab|east', task: 'résumé', version: 2, attempt: 3, artifactRevision: 7, schema: p.verification.schema };
    const key = `${p.identity.prefix}|lab%7Ceast|r%C3%A9sum%C3%A9|2|3${p.identity.artifactRevision ? '|7' : ''}`;
    const checks = p.verification.required.map(id => ({ id, origin: 'external', status: 'passed' }));
    const records = [
      { id: 'a', tags: ['x', 'x'], observedStep: 1, tokens: 1, status: 'current' },
      { id: 'b', tags: ['x', 'y'], observedStep: 2, tokens: p.retrieval.limit, status: 'current' },
      { id: 'c', tags: ['x'], observedStep: 0, tokens: 0, status: 'current' },
      { id: 'z', tags: ['x', 'y'], observedStep: 9, tokens: 0, status: 'stale' },
    ];
    const conflict = { status: 'unresolved', conflicts: [...p.lineage.claims].sort() };
    if (step === 0) {
      add('encoded-identity', [r], key);
      add('attempt-isolation', [{ ...r, attempt: 4 }], key.replace('|2|3', '|2|4'));
      add('tenant-isolation', [{ ...r, tenant: 'other' }], key.replace('lab%7Ceast', 'other'));
    } else if (step === 1) {
      add('preserve-history', [[r], { ...r, attempt: 4 }], { status: 'appended', history: [r, { ...r, attempt: 4 }] });
      add('duplicate-not-overwrite', [[r], { ...r, schema: 999 }], { status: 'duplicate', history: [r] });
      add('new-tenant', [[r], { ...r, tenant: 'other' }], { status: 'appended', history: [r, { ...r, tenant: 'other' }] });
    } else if (step === 2) {
      add('external-pass', [r, checks], { status: 'verified', missing: [] });
      add('stale-schema', [{ ...r, schema: 1 }, checks], { status: 'stale', missing: [] });
      add('self-report-rejected', [r, checks.map(c => ({ ...c, origin: 'submitter' }))], { status: 'failed', missing: [...p.verification.required].sort() });
      add('missing-required', [r, checks.slice(1)], { status: 'failed', missing: [checks[0].id] });
      add('duplicate-check', [r, [...checks, checks[0]]], { status: 'failed', missing: [checks[0].id] });
      add('failed-check', [r, [{ ...checks[0], status: 'failed' }, checks[1]]], { status: 'failed', missing: [checks[0].id] });
    } else if (step === 3) {
      add('skip-oversize-dedup-tags', [records, ['x', 'y'], 999], { selected: ['a', 'c'], omitted: ['b'] });
      add('exact-budget', [records, ['x'], 3], { selected: ['a'], omitted: ['b', 'c'] });
      const group = [{ ...records[0], conflict: 'g' }, { ...records[2], conflict: 'g' }];
      add('conflict-atomic', [group, ['x'], 5], { selected: [], omitted: ['a', 'c'] });
      add('conflict-cost-boundary', [group, ['x'], 6], { selected: ['a', 'c'], omitted: [] });
      add('zero-budget', [records, ['x'], 0], { selected: [], omitted: ['b', 'a', 'c'] });
      add('no-overlap', [records, ['absent'], 999], { selected: [], omitted: [] });
    } else if (step === 4) {
      add('current-unrelated', [{ source: p.lineage.current, claim: 'other' }], { status: 'accepted', conflicts: [] });
      add('old-source', [{ source: p.lineage.current.replace(/-b$/, '-a'), claim: 'other' }], { status: 'stale', conflicts: [] });
      add('equal-authority', [{ source: p.lineage.current, claim: p.lineage.conflict }], conflict);
      add('stale-before-conflict', [{ source: 'obsolete', claim: p.lineage.conflict }], { status: 'stale', conflicts: [] });
    } else {
      const request = { history: [r], record: { ...r, artifactRevision: 8 }, checks, delta: { source: p.lineage.current, claim: p.lineage.conflict }, records, tags: ['x', 'y'], budget: 999 };
      add('current-integration', [request], { identity: key.replace(/\|7$/, '|8'), history: [r, request.record], verification: { status: 'verified', missing: [] }, review: conflict, context: { selected: ['a', 'c'], omitted: ['b'] } });
      add('revised-context-bound', [{ ...request, records: [{ id: 'boundary', tags: ['x'], tokens: p.retrieval.limit - 2, status: 'current', observedStep: 5 }] }], { identity: key.replace(/\|7$/, '|8'), history: [r, request.record], verification: { status: 'verified', missing: [] }, review: conflict, context: { selected: ['boundary'], omitted: [] } });
      add('integration-rejects-stale', [{ ...request, record: { ...r, schema: 1 }, delta: { source: 'obsolete', claim: 'other' } }], { identity: key, history: [r], verification: { status: 'stale', missing: [] }, review: { status: 'stale', conflicts: [] }, context: { selected: ['a', 'c'], omitted: ['b'] } });
    }
  } else {
    const u = { input: 12, cached: 4, output: 3 };
    const cost = (p.counters.inputIncludesCache ? 8 : 12) * p.counters.rate + 4 + 3 * p.counters.outputRate;
    const stages = [{ id: 'owner', usage: u }, { id: 'child', usage: u }, { id: 'owner', usage: u }];
    const runs = [{ id: 'a', status: 'passed', duration: 10, cost: 7 }, { id: 'b', status: 'failed', duration: 3, cost: 5 }, { id: 'c', status: 'timeout', duration: null, cost: null }];
    const inclusion = { assigned: 3, accepted: 1, cappedDuration: 10 + 2 * p.billing.cap, knownCost: 12, incompleteIds: ['c'] };
    const rows = [{ block: 'a', arm: 'baseline', duration: 20, dataset: p.billing.dataset }, { block: 'a', arm: 'checkpoint', duration: 12, dataset: p.billing.dataset }, { block: 'b', arm: 'baseline', duration: 9, dataset: p.billing.dataset }, { block: 'a', arm: 'checkpoint', duration: 90, dataset: 'obsolete' }];
    const comparison = { pairs: [{ block: 'a', delta: -8 }], unpaired: ['b'], unresolved: [] };
    if (step === 0) {
      add('deltas-and-repeat', [[{ session: 'a', input: 10, cached: 3, output: 2 }, { session: 'a', input: 12, cached: 4, output: 3 }, { session: 'a', input: 12, cached: 4, output: 3 }]], { ...u, resets: 0 });
      add('reset-all-counters', [[{ session: 'a', input: 10, cached: 3, output: 2 }, { session: 'a', input: 11, cached: 1, output: 4 }, { session: 'b', input: 2, cached: 0, output: 1 }]], { input: 23, cached: 4, output: 7, resets: 1 });
      add('empty-ledger', [[]], { input: 0, cached: 0, output: 0, resets: 0 });
    } else if (step === 1) {
      add('cache-not-double-billed', [u], { uncached: 8, cached: 4, output: 3, cost });
      add('invalid-cache', [{ input: 2, cached: 3, output: 0 }], { status: 'invalid' });
      add('all-cached', [{ input: 4, cached: 4, output: 0 }], { uncached: 0, cached: 4, output: 0, cost: 4 });
    } else if (step === 2) {
      add('shared-stage-current-convention', [stages], { cost: 2 * cost, stageIds: ['child', 'owner'] });
      add('conflicting-stage', [[...stages, { id: 'owner', usage: { ...u, input: 13 } }]], { status: 'unresolved', ids: ['owner'] });
      add('empty-bill', [[]], { cost: 0, stageIds: [] });
    } else if (step === 3) {
      add('failures-and-missing', [runs], inclusion);
      add('passed-cap-and-missing-cost', [[{ id: 'z', status: 'passed', duration: 999, cost: null }]], { assigned: 1, accepted: 1, cappedDuration: p.billing.cap, knownCost: 0, incompleteIds: ['z'] });
      add('empty-cohort', [[]], { assigned: 0, accepted: 0, cappedDuration: 0, knownCost: 0, incompleteIds: [] });
    } else if (step === 4) {
      add('current-paired-only', [rows], comparison);
      add('duplicate-arm-unresolved', [[...rows, rows[0]]], { pairs: [], unpaired: ['b'], unresolved: ['a'] });
      add('old-dataset-excluded', [rows.map(r => ({ ...r, dataset: p.billing.dataset.replace(/-b$/, '-a') }))], { pairs: [], unpaired: [], unresolved: [] });
    } else {
      add('complete-report', [{ stages, runs, rows, claim: p.billing.conflict }], { billing: { cost: 2 * cost, stageIds: ['child', 'owner'] }, inclusion, comparison, allocation: { status: 'unresolved', conflicts: [...p.billing.claims].sort() }, currency: p.billing.currency, dataset: p.billing.dataset });
      add('empty-report', [{ stages: [], runs: [], rows: [], claim: 'other' }], { billing: { cost: 0, stageIds: [] }, inclusion: { assigned: 0, accepted: 0, cappedDuration: 0, knownCost: 0, incompleteIds: [] }, comparison: { pairs: [], unpaired: [], unresolved: [] }, allocation: { status: 'accepted', conflicts: [] }, currency: p.billing.currency, dataset: p.billing.dataset });
    }
  }
  return out;
}

function safePath(root, relative) {
  if (typeof relative !== 'string' || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(relative) || relative.split('/').some(p => p === '.' || p === '..')) throw new Error('Unsafe fixture path');
  const base = path.resolve(root);
  // Reject symlink ancestors, including those of root, rather than following an
  // existing link during materialization or candidate imports.
  let current = path.parse(base).root;
  for (const part of path.join(base, relative).slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) ? fs.lstatSync(current).isSymbolicLink() : isBrokenLink(current)) throw new Error('Symlink fixture path');
  }
  return path.join(base, relative);
}
function isBrokenLink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function writeFiles(files, root, updates = false) {
  const writes = Object.entries(files).map(([relative, bytes]) => {
    if (updates && !/^(inputs|docs)\//.test(relative)) throw new Error('Updates must use reserved inputs/docs paths');
    if (typeof bytes !== 'string') throw new TypeError('Fixture contents must be strings');
    return [safePath(root, relative), bytes];
  });
  for (const [target, bytes] of writes) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}
function getStep(fixture, index) {
  if (!Number.isInteger(index) || index < 0 || index >= 6 || !fixture.steps[index]) throw new RangeError('Invalid stepIndex');
  return fixture.steps[index];
}
export function materializeFixture(fixture, candidateRoot) { writeFiles(fixture.files, candidateRoot); }
export function applyStep(fixture, stepIndex, candidateRoot) { writeFiles(getStep(fixture, stepIndex).updates, candidateRoot, true); }

const runner = `
import fs from 'node:fs';
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const emit=process.stdout.write.bind(process.stdout);
try {
 const module=await import(request.url);
 const args=request.args;
 const before=JSON.stringify(args);
 const value=module[request.name](...args);
 if(value && typeof value.then==='function') throw new Error('Synchronous export returned a Promise or thenable');
 emit(JSON.stringify({value,mutated:before!==JSON.stringify(args)}));
} catch(error) { emit(JSON.stringify({error:String(error)})); }
`;

function execute(root, request) {
  return new Promise(resolve => {
    // Permission mode prevents candidate writes, subprocesses, workers and
    // network access. This is a test harness, not a hostile-code security VM.
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${root}`, '--input-type=module', '-e', runner], { cwd: root, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ error: 'Candidate timeout (2000ms)' }); }, 2000);
    child.on('error', error => finish({ error: String(error) }));
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 262144) { child.kill('SIGKILL'); finish({ error: 'Candidate output limit' }); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.on('close', code => {
      if (code !== 0) return finish({ error: `Candidate exit ${code}: ${stderr}` });
      try { finish(JSON.parse(stdout)); } catch { finish({ error: 'Invalid candidate protocol output' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export async function evaluateStep(fixture, stepIndex, candidateRoot) {
  const step = getStep(fixture, stepIndex);
  const checks = [];
  let target;
  try { target = safePath(candidateRoot, step.allowed_paths[0]); }
  catch (error) { return { passed: false, checks: [{ id: 'safe-module', passed: false, observed: String(error) }] }; }
  for (const test of step.oracle.cases) {
    const observed = await execute(path.resolve(candidateRoot), { url: pathToFileURL(target).href, name: names[fixture.family][stepIndex], args: test.args });
    checks.push({ id: test.id, passed: !observed.error && !observed.mutated && isDeepStrictEqual(observed.value, test.expected), observed });
  }
  return { passed: checks.length > 0 && checks.every(check => check.passed), checks };
}
