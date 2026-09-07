import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const trial=path.resolve(process.argv[2]);
const calls=new Map();
function walk(directory,actor){
 if(!fs.existsSync(directory))return;
 for(const item of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,item.name);
  if(item.isDirectory())walk(file,actor);
  else if(/^rollout-.*\.jsonl$/.test(item.name))for(const line of fs.readFileSync(file,'utf8').split('\n')){
   if(!line.trim())continue;
   const event=JSON.parse(line), payload=event.payload;
   if(event.type!=='event_msg'||payload?.type!=='item_completed'||payload.item?.type!=='McpToolCall')continue;
   const item=payload.item,key=`${actor}:${item.id}`;
   const receipt={actor,id:item.id,tool:item.tool,server:item.server,status:item.status,arguments:item.arguments,result:item.result};
   const digest=createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
   if(calls.has(key)&&calls.get(key).sha256!==digest)throw Error('conflicting MCP receipt: '+key);
   calls.set(key,{...receipt,sha256:digest,timestamp:event.timestamp,started_at_ms:payload.started_at_ms,completed_at_ms:payload.completed_at_ms});
  }
 }
}
const agents=path.join(trial,'subject','.relay','agents');
if(fs.existsSync(agents))for(const actor of fs.readdirSync(agents,{withFileTypes:true}))if(actor.isDirectory())walk(path.join(agents,actor.name),actor.name);
const result=[...calls.values()].sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
const output=path.join(trial,'native-mcp-ledger.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({output,receipts:result.length,errors:result.filter(r=>r.status==='failed'||r.result?.isError).length}));
