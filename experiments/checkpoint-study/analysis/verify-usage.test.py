import json
import pathlib
import subprocess
import tempfile

script=pathlib.Path(__file__).with_name('verify-usage.py')
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);sessions=root/'subject/.relay/agents/owner/sessions';sessions.mkdir(parents=True)
 u={'input_tokens':100,'cached_input_tokens':60,'output_tokens':7}
 event={'timestamp':'2026-01-01T00:00:00Z','type':'token_usage_record','payload':{'thread_id':'thread','response_id':'response','usage':u,'thread_token_usage':u}}
 counter={'timestamp':'2026-01-01T00:00:01Z','type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':u}}}
 accounting={'known_usage':{**u,'uncached_input_tokens':40},'per_actor':{'owner':u},'unique_requests':1,'usage_complete':True,'incomplete_actors':[]}
 def run(events,expected=('owner',),report=accounting):
  (sessions/'rollout-test.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in events))
  (root/'accounting.json').write_text(json.dumps(report));(root/'actor-inventory.json').write_text(json.dumps([{'task_id':a} for a in expected]))
  p=subprocess.run(['python3',str(script),str(root)],capture_output=True,text=True)
  return p,json.loads((root/'usage-verification.json').read_text()) if p.returncode==0 else None
 p,r=run([event,counter]);assert p.returncode==0 and r['arithmetic_status']=='matched';assert r['known_usage']['uncached_input_tokens']==40
 p,r=run([event,event,counter]);assert r['unique_requests']==1 and r['arithmetic_status']=='matched'
 p,r=run([event,counter],('owner','missing-child'));assert r['expected_actors_without_usage']==['missing-child']
 bad=json.loads(json.dumps(event));bad['payload']['usage']['output_tokens']=8
 p,r=run([event,bad,counter]);assert p.returncode!=0 and 'conflicting response ID' in p.stderr
 bad_counter=json.loads(json.dumps(counter));bad_counter['payload']['info']['total_token_usage']['output_tokens']=9
 p,r=run([event,bad_counter]);assert any(not x['matches_sum'] for x in r['thread_checks']) and r['arithmetic_status']=='matched'
 bad_report=json.loads(json.dumps(accounting));bad_report['known_usage']['input_tokens']=200
 p,r=run([event,counter],report=bad_report);assert r['arithmetic_status']=='mismatch'
 p,r=run([event]);assert any(x['kind']=='event_counter' and not x['matches_sum'] for x in r['thread_checks'])
print(json.dumps({'passed':7,'checks':['cached input separated','same response deduplicated','missing actor retained','conflicting response rejected','counter mismatch retained','reported sum mismatch detected','missing cumulative counter retained']}))
