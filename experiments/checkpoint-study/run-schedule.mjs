import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runSequence} from './native-driver.mjs';
import {buildFixture} from './fixtures.mjs';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const git=(...args)=>execFileSync('git',args,{cwd:sourceRoot,encoding:'utf8',timeout:10000}).trim();
const write=(file,value)=>{fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);};
export function plannedSequences(){
  const sequence=[];
  for(const seed of [17,96])for(const family of ['evidence-service','research-accounting'])for(const arm of seed===17?['task-only','checkpoint','warm']:['warm','checkpoint','task-only'])sequence.push({id:`${String(sequence.length+1).padStart(2,'0')}-${family}-${seed}-${arm}`,family,seed,arm});
  return sequence;
}
export async function runSchedule(directory,termd){
  if(fs.existsSync(directory))throw Error('refusing to reuse schedule directory');
  if(git('status','--porcelain'))throw Error('freeze requires a clean source checkout');
  const source_commit=git('rev-parse','HEAD');
  fs.mkdirSync(directory,{recursive:true});
  const assignments=plannedSequences().map(item=>({...item,status:'assigned',planned_steps:6,fixture_sha256:createHash('sha256').update(JSON.stringify(buildFixture(item.family,item.seed))).digest('hex')}));
  const manifest={source_commit,created_at:new Date().toISOString(),purpose:'descriptive feasibility; four matched blocks; no general superiority claim',planned_sequences:12,planned_steps:72,assignments};
  write(path.join(directory,'schedule.json'),manifest);
  for(const assignment of assignments){
    if(git('rev-parse','HEAD')!==source_commit||git('status','--porcelain'))throw Error('frozen harness changed; remaining assignments retained without replacement');
    const trial=path.join(directory,assignment.id);
    write(path.join(directory,'current.json'),{directory:trial,id:assignment.id});
    assignment.status='running';write(path.join(directory,'schedule.json'),manifest);
    try{
      const result=await runSequence({directory:trial,family:assignment.family,seed:assignment.seed,arm:assignment.arm,termd,phase:'evaluation'});
      assignment.status=result.status;assignment.passed=result.passed;assignment.failure=result.failure;
      write(path.join(directory,'schedule.json'),manifest);
      if(result.errors.some(error=>error.stage==='shutdown'))throw Error('shutdown failed; halt schedule until live process state is resolved');
    }catch(error){
      assignment.status='controller_error';assignment.failure=String(error);write(path.join(directory,'schedule.json'),manifest);throw error;
    }
  }
  manifest.finished_at=new Date().toISOString();write(path.join(directory,'schedule.json'),manifest);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [directory,termd]=process.argv.slice(2);if(!directory||!termd)throw Error('usage: run-schedule.mjs NEW_DIRECTORY TERMD_PATH');
  await runSchedule(path.resolve(directory),path.resolve(termd));
}
