import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, materializeFixture, applyStep, evaluateStep } from './fixtures.mjs';

const prelude = `import fs from 'node:fs';
const policy = name => JSON.parse(fs.readFileSync(new URL('../inputs/'+name+'.json',import.meta.url),'utf8'));
`;
// Handwritten implementations follow public documentation. They neither read
// private fixture metadata nor share implementation helpers with the oracle.
const evidence = {
  identity: `export function identity(r) { const p=policy('identity'); return [p.prefix,r.tenant,r.task,r.version,r.attempt,...(p.artifactRevision?[r.artifactRevision]:[])].map(x=>encodeURIComponent(String(x))).join('|'); }`,
  append: `import {identity} from './identity.mjs';
export function append(history,r) { return history.some(x=>identity(x)===identity(r))?{status:'duplicate',history}:{status:'appended',history:[...history,r]}; }`,
  verify: `export function verify(r,checks) { const p=policy('verification'); if(r.schema!==p.schema)return {status:'stale',missing:[]}; const missing=p.required.filter(id=>{const c=checks.filter(x=>x.id===id);return c.length!==1||c[0].origin!=='external'||c[0].status!=='passed';}).sort(); return {status:missing.length?'failed':'verified',missing}; }`,
  select: `export function select(records,tags,budget) {
 const p=policy('retrieval'), groups=new Map();
 for(const r of records) { const overlap=new Set(r.tags.filter(t=>tags.includes(t))).size; if(r.status!=='current'||!overlap)continue; const key=r.conflict?'conflict:'+r.conflict:'record:'+r.id; if(!groups.has(key))groups.set(key,[]);groups.get(key).push({...r,overlap}); }
 const ordered=[...groups.values()].map(g=>g.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)).sort((a,b)=>Math.max(...b.map(r=>r.overlap))-Math.max(...a.map(r=>r.overlap))||Math.max(...b.map(r=>r.observedStep))-Math.max(...a.map(r=>r.observedStep))||(a[0].id<b[0].id?-1:a[0].id>b[0].id?1:0));
 let remaining=Math.min(budget,p.limit); const selected=[],omitted=[];
 for(const g of ordered) {const cost=g.reduce((n,r)=>n+r.tokens+p.overhead,0)+(g[0].conflict?p.conflictCost:0); if(cost<=remaining){selected.push(...g.map(r=>r.id));remaining-=cost;}else omitted.push(...g.map(r=>r.id));} return {selected,omitted};
}`,
  review: `export function review(delta) {const p=policy('lineage'); if(delta.source!==p.current)return {status:'stale',conflicts:[]}; return delta.claim===p.conflict?{status:'unresolved',conflicts:p.claims.sort()}:{status:'accepted',conflicts:[]};}`,
  integrate: `import {identity} from './identity.mjs'; import {append} from './append.mjs'; import {verify} from './verify.mjs'; import {select} from './select.mjs'; import {review} from './review.mjs';
export function integrate(q) {return {identity:identity(q.record),history:append(q.history,q.record).history,verification:verify(q.record,q.checks),review:review(q.delta),context:select(q.records,q.tags,q.budget)};}`,
};
const accounting = {
  usage: `export function usage(samples) {const previous=new Map(),total={input:0,cached:0,output:0,resets:0}; for(const s of samples){const old=previous.get(s.session);const reset=old&&['input','cached','output'].some(k=>s[k]<old[k]);if(reset)total.resets++;for(const k of ['input','cached','output'])total[k]+=s[k]-(old&&!reset?old[k]:0);previous.set(s.session,s);}return total;}`,
  cache: `export function cache(u) {const p=policy('counters');const uncached=u.input-(p.inputIncludesCache?u.cached:0);if(uncached<0)return {status:'invalid'};return {uncached,cached:u.cached,output:u.output,cost:uncached*p.rate+u.cached*p.cacheRate+u.output*p.outputRate};}`,
  bill: `import {cache} from './cache.mjs';
export function bill(stages) {const seen=new Map(),bad=new Set();for(const s of stages){if(seen.has(s.id)&&['input','cached','output'].some(k=>seen.get(s.id)[k]!==s.usage[k]))bad.add(s.id);seen.set(s.id,s.usage);}if(bad.size)return {status:'unresolved',ids:[...bad].sort()};let cost=0;for(const u of seen.values()){const c=cache(u);if(c.status==='invalid')return c;cost+=c.cost;}return {cost,stageIds:[...seen.keys()].sort()};}`,
  include: `export function include(runs) {const cap=policy('billing').cap;return {assigned:runs.length,accepted:runs.filter(r=>r.status==='passed').length,cappedDuration:runs.reduce((n,r)=>n+(r.status==='passed'&&r.duration!==null?Math.min(r.duration,cap):cap),0),knownCost:runs.reduce((n,r)=>n+(r.cost??0),0),incompleteIds:runs.filter(r=>r.cost===null||r.duration===null).map(r=>r.id).sort()};}`,
  pair: `export function pair(rows) {const p=policy('billing'),groups=new Map();for(const r of rows){if(r.dataset!==p.dataset)continue;if(!groups.has(r.block))groups.set(r.block,[]);groups.get(r.block).push(r);}const pairs=[],unpaired=[],unresolved=[];for(const block of [...groups.keys()].sort()){const g=groups.get(block),c=g.filter(r=>r.arm==='checkpoint'),b=g.filter(r=>r.arm==='baseline');if(c.length>1||b.length>1)unresolved.push(block);else if(c.length===1&&b.length===1)pairs.push({block,delta:c[0].duration-b[0].duration});else unpaired.push(block);}return {pairs,unpaired,unresolved};}`,
  report: `import {bill} from './bill.mjs';import {include} from './include.mjs';import {pair} from './pair.mjs';
export function report(q) {const p=policy('billing');return {billing:bill(q.stages),inclusion:include(q.runs),comparison:pair(q.rows),allocation:q.claim===p.conflict?{status:'unresolved',conflicts:p.claims.sort()}:{status:'accepted',conflicts:[]},currency:p.currency,dataset:p.dataset};}`,
};

function scratch(t) {
  // realpath avoids macOS /var -> /private/var symlinks in the parent path.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'checkpoint-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeCandidate(fixture, root) {
  const modules = fixture.family === 'evidence-service' ? evidence : accounting;
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [name, code] of Object.entries(modules)) fs.writeFileSync(path.join(root, 'src', name + '.mjs'), prelude + code);
}
function snapshot(root) {
  const out = {};
  const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file=path.join(dir,entry.name);if(entry.isDirectory())visit(file);else out[path.relative(root,file)]=fs.readFileSync(file,'utf8'); } };
  visit(root); return out;
}

test('rejects an async export even when its resolved values match every oracle case', async t => {
  const fixture = buildFixture('evidence-service', 17), root = scratch(t);
  materializeFixture(fixture, root); writeCandidate(fixture, root);
  fs.writeFileSync(path.join(root, 'src/identity.mjs'), prelude + evidence.identity.replace('export function', 'export async function'));
  assert.equal((await evaluateStep(fixture, 0, root)).passed, false);
});

test('deterministic, serializable six-step manifests with private oracles and disjoint scopes', () => {
  for (const family of ['evidence-service','research-accounting']) {
    const a=buildFixture(family,0), b=buildFixture(family,17);
    assert.deepEqual(a,buildFixture(family,0));
    assert.deepEqual(a,JSON.parse(JSON.stringify(a)));
    assert.notDeepEqual(a.files,b.files);
    assert.equal(a.steps.length,6);
    assert.equal(new Set(a.steps.flatMap(s=>s.allowed_paths)).size,6);
    assert.equal(JSON.parse(a.files['package.json']).type,'module');
    assert.equal(a.steps.filter(s=>Object.keys(s.updates).length).length,2);
    for(const s of a.steps) {
      assert.ok(s.tags.length>1);
      assert.ok(s.oracle.cases.length>=2);
      assert.match(s.allowed_paths[0],/^src\/[a-z]+\.mjs$/);
      for(const p of Object.keys(s.updates))assert.match(p,/^(inputs|docs)\//);
      assert.doesNotMatch(s.goal,/inputs\/|docs\/|oracle|hidden/);
      for(const c of s.oracle.cases)assert.ok(!Object.values(a.files).some(bytes=>bytes.includes(c.id)));
    }
    assert.ok(Object.keys(a.files).every(p=>!p.includes('oracle')&&!p.startsWith('src/')&&!p.includes('test')));
  }
  for(const seed of [-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>buildFixture('evidence-service',seed));
  assert.throws(()=>buildFixture('unknown',1));
});

for(const family of ['evidence-service','research-accounting']) for(const seed of [0,17,96]) {
  test(`${family} seed ${seed}: correct handcrafted candidate passes all six evolving steps without mutation`, async t => {
    const f=buildFixture(family,seed),root=scratch(t);
    materializeFixture(f,root);
    assert.deepEqual(snapshot(root),f.files);
    writeCandidate(f,root);
    for(let i=0;i<6;i++) {
      const prior=snapshot(root);
      applyStep(f,i,root);
      const before=snapshot(root);
      for(const name of f.steps.flatMap(s=>s.allowed_paths))assert.equal(before[name],prior[name]);
      const result=await evaluateStep(f,i,root);
      assert.equal(result.passed,true,JSON.stringify(result));
      assert.deepEqual(snapshot(root),before);
    }
  });
}

test('stale policies fail updated billing, lineage and final integration checks', async t => {
  for(const family of ['evidence-service','research-accounting']) {
    const f=buildFixture(family,17),root=scratch(t);materializeFixture(f,root);writeCandidate(f,root);
    // Intentionally withhold source updates, representing a stale remembered rule.
    for(const i of [2,4,5])assert.equal((await evaluateStep(f,i,root)).passed,false,`${family} step ${i}`);
    for(let i=0;i<6;i++)applyStep(f,i,root);
    assert.equal((await evaluateStep(f,5,root)).passed,true);
    // Earlier oracle expectations do not silently adopt future source changes.
    assert.equal((await evaluateStep(f,family==='evidence-service'?0:1,root)).passed,false);
  }
});

test('naive candidates fail functional checks for every deliverable', async t => {
  for(const family of ['evidence-service','research-accounting']) {
    const f=buildFixture(family,0),root=scratch(t);materializeFixture(f,root);writeCandidate(f,root);
    for(let i=0;i<6;i++) {
      applyStep(f,i,root);
      const file=path.join(root,f.steps[i].allowed_paths[0]);
      const good=fs.readFileSync(file,'utf8');
      fs.writeFileSync(file,`export function ${f.steps[i].title}(){return {status:'passed'};}`);
      assert.equal((await evaluateStep(f,i,root)).passed,false);
      fs.writeFileSync(file,good);
    }
  }
});

test('targeted plausible mistakes are caught independently', async t => {
  const mutations = [
    ['evidence-service',1,"identity(x)===identity(r)","x.task===r.task"],
    ['evidence-service',2,"c[0].origin!=='external'","false"],
    ['evidence-service',3,"Math.min(budget,p.limit)","budget"],
    ['evidence-service',4,"{status:'unresolved',conflicts:p.claims.sort()}","{status:'accepted',conflicts:[]}"],
    ['research-accounting',0,"old&&!reset?old[k]:0","0"],
    ['research-accounting',2,"cost+=c.cost","cost+=c.cost*stages.filter(s=>s.usage.input===u.input).length"],
    ['research-accounting',3,"assigned:runs.length","assigned:runs.filter(r=>r.status==='passed').length"],
    ['research-accounting',4,"if(r.dataset!==p.dataset)continue;",""],
    ['research-accounting',5,"{status:'unresolved',conflicts:p.claims.sort()}","{status:'accepted',conflicts:[]}"],
  ];
  for(const [family,step,from,to] of mutations) {
    const f=buildFixture(family,17),root=scratch(t);materializeFixture(f,root);writeCandidate(f,root);
    for(let i=0;i<=step;i++)applyStep(f,i,root);
    const file=path.join(root,f.steps[step].allowed_paths[0]), code=fs.readFileSync(file,'utf8');
    assert.ok(code.includes(from));fs.writeFileSync(file,code.replace(from,to));
    assert.equal((await evaluateStep(f,step,root)).passed,false,`${family} ${step}: ${from}`);
  }
});

test('second update invalidates a bound already used by an earlier deliverable', async t => {
  for(const family of ['evidence-service','research-accounting']) {
    const f=buildFixture(family,17),root=scratch(t);materializeFixture(f,root);writeCandidate(f,root);
    for(let i=0;i<6;i++)applyStep(f,i,root);
    const file=family==='evidence-service'?'inputs/retrieval.json':'inputs/billing.json';
    const field=family==='evidence-service'?'limit':'cap';
    const p=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
    p[field]=JSON.parse(f.files[file])[field];
    fs.writeFileSync(path.join(root,file),JSON.stringify(p));
    assert.equal((await evaluateStep(f,5,root)).passed,false);
  }
});

test('evaluation isolates module caches across repeated evaluations and candidates', async t => {
  const f=buildFixture('evidence-service',0),a=scratch(t),b=scratch(t);
  for(const root of [a,b]){materializeFixture(f,root);writeCandidate(f,root);}
  assert.equal((await evaluateStep(f,0,a)).passed,true);
  fs.writeFileSync(path.join(a,'src/identity.mjs'),'export const identity=()=>"bad";');
  assert.equal((await evaluateStep(f,0,a)).passed,false);
  assert.equal((await evaluateStep(f,0,b)).passed,true);
  writeCandidate(f,a);assert.equal((await evaluateStep(f,0,a)).passed,true);
});

test('path validation prevents traversal, reserved-output updates and symlink writes', t => {
  const f=buildFixture('evidence-service',0),root=scratch(t),outside=scratch(t);
  for(const bad of ['../escape','/absolute','src/../../escape','src\\escape','src/./file'])assert.throws(()=>materializeFixture({...f,files:{[bad]:'x'}},root),/Unsafe/);
  const hostile=structuredClone(f);hostile.steps[0].updates={'src/identity.mjs':'x'};
  assert.throws(()=>applyStep(hostile,0,root),/reserved/);
  fs.symlinkSync(outside,path.join(root,'docs'));
  assert.throws(()=>materializeFixture(f,root),/Symlink/);
  assert.deepEqual(fs.readdirSync(outside),[]);
  assert.deepEqual(fs.readdirSync(root),['docs']); // Validation precedes all writes.
  assert.throws(()=>applyStep(f,6,root),/stepIndex/);
});

test('missing, noisy, mutating and hanging candidates fail with bounded structured errors', async t => {
  const f=buildFixture('evidence-service',0),root=scratch(t);materializeFixture(f,root);
  assert.equal((await evaluateStep(f,0,root)).passed,false);
  writeCandidate(f,root);
  // One private case suffices for infrastructure checks and keeps timeout testing bounded.
  f.steps[0].oracle.cases=f.steps[0].oracle.cases.slice(0,1);
  for(const code of [
    `console.log('noise');export const identity=()=>'';`,
    `import fs from 'node:fs';export function identity(){fs.writeFileSync('unauthorized','x');return '';}`,
    `export function identity(r){r.tenant='changed';return '';}`,
    `export function identity(){while(true){}}`,
  ]) {
    fs.writeFileSync(path.join(root,'src/identity.mjs'),code);
    const before=snapshot(root),start=Date.now(),result=await evaluateStep(f,0,root);
    assert.equal(result.passed,false);assert.ok(Date.now()-start<5000);assert.deepEqual(snapshot(root),before);
  }
});
