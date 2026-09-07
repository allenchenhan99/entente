import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import ts from 'typescript';

const study=path.resolve(process.argv[2]);
const repo=path.resolve(process.argv[3]);
const commit=JSON.parse(fs.readFileSync(path.join(study,'summary.json'))).source_commit;
const hash=x=>createHash('sha256').update(x).digest('hex');
const source=execFileSync('git',['show',`${commit}:apps/relayd/src/launch/prompts.ts`],{cwd:repo,encoding:'utf8'});
const protocolUrl=pathToFileURL(path.join(repo,'packages/protocol/dist/index.js')).href;
const js=ts.transpileModule(source.replace("'@relay/protocol'",JSON.stringify(protocolUrl)),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {bootstrapPrompt}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
// Tool-name imports must remain equal to the study source, rather than silently
// testing old prompts with changed protocol constants.
for(const file of ['packages/protocol/src/mcp.ts','packages/protocol/src/checkpoint.ts']){
 const old=execFileSync('git',['show',`${commit}:${file}`],{cwd:repo});
 if(!old.equals(fs.readFileSync(path.join(repo,file))))throw Error(`protocol changed: ${file}`);
}
const rows=[],variants={},environments={};
function walk(dir){if(!fs.existsSync(dir))return [];return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):/^rollout-.*\.jsonl$/.test(e.name)?[path.join(dir,e.name)]:[]);}
function unpack(r){return r.structuredContent??JSON.parse(r.content.find(x=>x.type==='text').text);}
for(const name of fs.readdirSync(study).filter(n=>/^\d\d-/.test(n)).sort()){
 const trial=path.join(study,name),native=JSON.parse(fs.readFileSync(path.join(trial,'native-mcp-ledger.json'))),contracts=new Map();
 for(const r of native){
  if(r.tool==='relay_get_contract'&&!r.result?.isError){const c=unpack(r.result).contract;contracts.set(c.id,c);}
  if(r.tool==='relay_propose_subtask')contracts.set(r.arguments.contract.id,r.arguments.contract);
 }
 const actors=path.join(trial,'subject/.relay/agents');
 for(const actor of fs.readdirSync(actors)){
  const users=[],developers=[],files=[];
  for(const file of walk(path.join(actors,actor,'sessions'))){
   const bytes=fs.readFileSync(file);files.push({path:path.relative(trial,file),sha256:hash(bytes)});
   for(const line of bytes.toString().split('\n').filter(Boolean)){
    const e=JSON.parse(line),p=e.payload??{};
    if(e.type==='response_item'&&p.type==='message'&&['user','developer'].includes(p.role)){
     const body=p.content.map(x=>x.text??'').join('\n');(p.role==='user'?users:developers).push(body);
    }
   }
  }
  if(users.length!==2)throw Error(`${name}/${actor}: expected two initial user messages, got ${users.length}`);
  const cwd=users[0].match(/<cwd>([^<]+)<\/cwd>/)?.[1];
  if(!cwd||!users[0].startsWith('<environment_context>'))throw Error('unexpected environment message');
  const contract=contracts.get(actor);if(!contract)throw Error(`missing contract ${name}/${actor}`);
  const expected=bootstrapPrompt({taskId:actor,cwd,role:'recipient',contractSummary:contract.goal});
  if(users[1]!==expected)throw Error(`noncanonical bootstrap: ${name}/${actor}`);
  const normalize=s=>s.replaceAll(path.join(actors,actor),'<ACTOR_CONFIG>').replaceAll(cwd,'<WORKTREE>').replaceAll(path.join(trial,'subject'),'<SUBJECT>');
  const env=normalize(users[0]);environments[hash(env)]=env;
  const developerHashes=developers.map(body=>{const normalized=normalize(body),h=hash(normalized);variants[h]=normalized;return h;});
  rows.push({trial:name,actor,user_messages:2,bootstrap_matches_frozen_renderer:true,bootstrap_sha256:hash(users[1]),environment_normalized_sha256:hash(env),developer_normalized_hashes:developerHashes,files});
 }
}
const output={status:'matched_initial_user_messages',frozen_commit:commit,frozen_prompt_source_sha256:hash(source),actors:rows,environment_variants:environments,developer_variants:Object.fromEntries(Object.entries(variants).map(([h,text])=>[h,{characters:text.length}])),limits:['Canonical user bootstrap and exactly two recorded user messages exclude additional recorded user prompts in these rollouts, not unavailable provider-internal activity.','Developer variants require separate semantic inspection; catalog drift is not removed by matching user bootstrap.']};
fs.writeFileSync(path.join(study,'bootstrap-message-verification.json'),JSON.stringify(output,null,2)+'\n');
fs.writeFileSync(path.join(study,'developer-message-variants.json'),JSON.stringify(variants,null,2)+'\n');
console.log(JSON.stringify({actors:rows.length,environment_variants:Object.keys(environments).length,developer_variants:Object.keys(variants).length}));
