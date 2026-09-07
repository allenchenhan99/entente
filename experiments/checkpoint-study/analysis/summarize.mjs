import fs from 'node:fs';
import path from 'node:path';
const directory=path.resolve(process.argv[2]);
const schedule=JSON.parse(fs.readFileSync(path.join(directory,'schedule.json'),'utf8'));
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const rows=schedule.assignments.map(assignment=>{
  const trial=path.join(directory,assignment.id), result=read(path.join(trial,'result.json'));
  const usage=result?.accounting;
  const operationFile=path.join(trial,'subject','.relay','checkpoints','operations.jsonl');
  const operations=fs.existsSync(operationFile)?fs.readFileSync(operationFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const checkpoint={};
  for(const operation of operations){
    const key=operation.operation, aggregate=checkpoint[key]??={calls:0,errors:0,duration_ms:0,input_bytes:0,output_bytes:0};
    aggregate.calls++;aggregate.errors+=operation.status==='ok'?0:1;
    for(const field of ['duration_ms','input_bytes','output_bytes'])aggregate[field]+=operation[field]??0;
  }
  const review=read(path.join(trial,'independent-semantic-review.json'))??read(path.join(trial,'semantic-review.json'));
  const ledger=read(path.join(trial,'access-ledger.json'));
  return {id:assignment.id,family:assignment.family,seed:assignment.seed,arm:assignment.arm,
    schedule_status:assignment.status,result_status:result?.status??'missing',failure:result?.failure??assignment.failure??null,
    planned_steps:6,archived_steps:result?.archived_steps??0,functional_pass_steps:result?.quality?.filter(q=>q.status==='evaluated'&&q.passed).length??0,
    functional_unknown_steps:result?.quality?.filter(q=>q.status!=='evaluated').length??6,
    sequence_passed:result?.passed??false,mission_status:result?.mission_status??null,
    workflow_ms:result?.workflow_elapsed_ms??null,end_to_end_ms:result?.end_to_end_ms??null,
    usage_complete:usage?.usage_complete===true,known_usage:usage?.known_usage??null,per_actor_usage:usage?.per_actor??null,
    incomplete_actors:usage?.incomplete_actors??null,checkpoint,
    access_calls:ledger?.length??null,semantic_review_status:review?.status??'pending',semantic_review:review,
  };
});
const pairs=[];
for(const seed of [17,96])for(const family of ['evidence-service','research-accounting']){
  const block=rows.filter(row=>row.seed===seed&&row.family===family),baseline=block.find(row=>row.arm==='task-only');
  for(const arm of ['checkpoint','warm']){
    const treatment=block.find(row=>row.arm===arm);
    const difference=(a,b)=>typeof a==='number'&&typeof b==='number'?a-b:null;
    const complete=baseline.usage_complete&&treatment.usage_complete;
    pairs.push({seed,family,contrast:`${arm} minus task-only`,
      functional_pass_delta:treatment.functional_pass_steps-baseline.functional_pass_steps,
      end_to_end_delta_ms:difference(treatment.end_to_end_ms,baseline.end_to_end_ms),
      usage_complete:complete,
      uncached_input_delta:complete?difference(treatment.known_usage.uncached_input_tokens,baseline.known_usage.uncached_input_tokens):null,
      cached_input_delta:complete?difference(treatment.known_usage.cached_input_tokens,baseline.known_usage.cached_input_tokens):null,
      output_delta:complete?difference(treatment.known_usage.output_tokens,baseline.known_usage.output_tokens):null,
      interpretation:baseline.semantic_review_status.startsWith('reviewed')&&treatment.semantic_review_status.startsWith('reviewed')?'descriptive only; inspect failures, quality, censoring and review findings':'pending semantic audit; no efficiency conclusion',
    });
  }
}
const report={source_commit:schedule.source_commit,planned_sequences:12,planned_steps:72,
  terminal_sequences:rows.filter(row=>['failed','finished'].includes(row.result_status)).length,
  usage_complete_sequences:rows.filter(row=>row.usage_complete).length,
  functional_pass_steps:rows.reduce((sum,row)=>sum+row.functional_pass_steps,0),rows,pairs,
  limits:['Four matched blocks, descriptive feasibility only.','Failed and incomplete assignments retained; missing usage is unknown, never zero.','Checkpoint service durations are included in wall time, not additive surcharges.','No per-operation model-token attribution or dollar estimate is inferred.','Semantic access coding and operator interventions must be reviewed before conclusions.']};
const output=process.argv[3]??path.join(directory,'summary.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({output,terminal_sequences:report.terminal_sequences,planned_sequences:12,usage_complete_sequences:report.usage_complete_sequences}));
