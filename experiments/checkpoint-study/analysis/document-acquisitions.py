"""Explicit cat actions only; never execute agent-authored commands or infer waste."""
import pathlib,json,re,shlex,subprocess,hashlib,sys
trial=pathlib.Path(sys.argv[1]).resolve()
ledger=json.loads((trial/'access-ledger.json').read_text())
manifest=json.loads((trial/'manifest.json').read_text())
timeline=[json.loads(line) for line in (trial/'timeline.jsonl').read_text().splitlines() if line]
steps={e['step']:e['source_sha'] for e in timeline if e['type']=='step_started'}
observations=[]; unresolved=[]
for row in ledger:
 commit=steps.get(row['step'],manifest['baseline_sha'])
 for index,candidate in enumerate(row['commands']):
  command=candidate.get('command')
  if command is None:
   unresolved.append({'call_id':row['call_id'],'actor':row['actor'],'reason':'dynamic command; inspect raw input/output'});continue
  for match in re.finditer(r'(?:^|&&|;|\n)\s*cat\s+([^;&\n]+)',command):
   try: files=shlex.split(match.group(1))
   except ValueError:
    unresolved.append({'call_id':row['call_id'],'reason':'unparseable cat arguments'});continue
   for file in files:
    if file.startswith('-') or any(c in file for c in '*?$><|') or pathlib.PurePosixPath(file).is_absolute() or '..' in pathlib.PurePosixPath(file).parts:
     unresolved.append({'call_id':row['call_id'],'path':file,'reason':'nonliteral or unsupported path/argument'});continue
    try: content=subprocess.check_output(['git','--no-replace-objects','show',f'{commit}:{file}'],cwd=trial/'subject',stderr=subprocess.DEVNULL,timeout=10)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired):
     unresolved.append({'call_id':row['call_id'],'path':file,'reason':'path absent in recorded source commit; inspect working-tree output'});continue
    sha=hashlib.sha256(content).hexdigest()
    previous=[x for x in observations if x['path']==file and x['source_sha256']==sha]
    observations.append({'actor':row['actor'],'step':row['step'],'call_id':row['call_id'],'input_sha256':row['input_sha256'],'output_sha256':row['output_sha256'],'command_index':index,'path':file,'source_commit':commit,'source_sha256':sha,'bytes':len(content),'prior_same_actor_same_bytes':any(x['actor']==row['actor'] for x in previous),'prior_other_actor_same_bytes':any(x['actor']!=row['actor'] for x in previous),'classification':'document_acquisition_candidate','semantic_review':'pending'})
result={'method':'Static literal cat extraction, source-commit blob hashes; no execution of agent tool input. Candidates need output and purpose review. Does not cover other source-reading methods. Repetition does not establish avoidable waste.','observations':observations,'unresolved':unresolved}
(trial/'document-acquisitions.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'candidates':len(observations),'same_actor_reacquisitions':sum(x['prior_same_actor_same_bytes'] for x in observations),'cross_actor_reacquisitions':sum(x['prior_other_actor_same_bytes'] for x in observations),'unresolved':len(unresolved),'semantic_review':'pending'}))
