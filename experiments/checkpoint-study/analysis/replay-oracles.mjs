import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {evaluateStep,buildFixture} from '../fixtures.mjs';
const trial=path.resolve(process.argv[2]);
const read=name=>JSON.parse(fs.readFileSync(path.join(trial,name),'utf8'));
const result=read('result.json'), manifest=read('manifest.json'), fixture=read('private-fixture.json');
if(!['finished','failed'].includes(result.status))throw Error('only terminal trials may be replayed');
if(!isDeepStrictEqual(fixture,buildFixture(manifest.family,manifest.seed)))throw Error('saved fixture differs from frozen generator');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function snapshot(root){
 const rows=[];
 function visit(dir){for(const name of fs.readdirSync(dir).sort()){
  const file=path.join(dir,name),stat=fs.lstatSync(file);
  if(stat.isDirectory())visit(file);
  else if(stat.isFile())rows.push({path:path.relative(root,file),sha256:hash(fs.readFileSync(file))});
  else throw Error('nonregular archive member');
 }} visit(root);return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
function gitSnapshot(commit){
 const opts={cwd:path.join(trial,'subject'),timeout:10000,maxBuffer:64*1024*1024};
 const entries=execFileSync('git',['ls-tree','-rz','--full-tree',commit],opts).toString().split('\0').filter(Boolean);
 return entries.map(line=>{
  const tab=line.indexOf('\t'),[mode,type,oid]=line.slice(0,tab).split(' '),file=line.slice(tab+1);
  if(type!=='blob'||!['100644','100755'].includes(mode))throw Error('unexpected archived Git entry');
  return {path:file,sha256:hash(execFileSync('git',['cat-file','blob',oid],opts))};
 }).sort((a,b)=>a.path.localeCompare(b.path));
}
const rows=[];
for(const quality of result.quality){
 if(quality.status!=='evaluated'){rows.push({step:quality.step,status:'not_replayed',original_status:quality.status});continue;}
 const root=path.join(trial,`step-${quality.step}`),before=snapshot(root),committed=gitSnapshot(quality.commit);
 if(!isDeepStrictEqual(before,committed))throw Error(`step ${quality.step}: archive differs from committed tree`);
 const replay=await evaluateStep(fixture,quality.step-1,root);
 if(!isDeepStrictEqual(before,snapshot(root)))throw Error('oracle replay changed archive');
 rows.push({step:quality.step,commit:quality.commit,archive_sha256:hash(JSON.stringify(before)),status:'replayed',matches_original:isDeepStrictEqual(replay,{passed:quality.passed,checks:quality.checks}),...replay});
}
const output={status:rows.every(r=>r.status!=='replayed')?'not_replayed':rows.filter(r=>r.status==='replayed').every(r=>r.matches_original)?'matched':'mismatch',method:'Independent invocation using saved fixture; exact full archive path/content hashes checked against recorded Git tree before replay and unchanged afterward. Same frozen oracle, not independent oracle design.',fixture_sha256:hash(fs.readFileSync(path.join(trial,'private-fixture.json'))),original_result_sha256:hash(fs.readFileSync(path.join(trial,'result.json'))),evaluator_sha256:hash(fs.readFileSync(new URL('../fixtures.mjs', import.meta.url))),limitations:['Reproducibility does not repair omitted public requirements or establish exhaustive correctness.','Nonarchived assignments remain missing and are not imputed.'],steps:rows};
fs.writeFileSync(path.join(trial,'oracle-replay.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({trial:path.basename(trial),status:output.status,replayed:rows.filter(r=>r.status==='replayed').length,missing:rows.filter(r=>r.status!=='replayed').length}));
