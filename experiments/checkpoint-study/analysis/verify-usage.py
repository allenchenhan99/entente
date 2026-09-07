"""Independent arithmetic reconciliation, not a replacement for lifecycle completeness checks."""
import collections
import hashlib
import json
import pathlib
import sys

trial = pathlib.Path(sys.argv[1]).resolve()
accounting = json.loads((trial / 'accounting.json').read_text())
inventory = json.loads((trial / 'actor-inventory.json').read_text())
fields = ('input_tokens', 'cached_input_tokens', 'output_tokens')
requests = {}
snapshots = collections.defaultdict(list)
files = []
invalid = []

def usage(value):
    if not isinstance(value, dict) or any(type(value.get(k)) is not int or value[k] < 0 for k in fields):
        return None
    if value['cached_input_tokens'] > value['input_tokens']:
        return None
    return {k:value[k] for k in fields}

for actor in sorted((trial / 'subject/.relay/agents').iterdir()):
    if not actor.is_dir():
        continue
    for file in sorted(actor.rglob('rollout-*.jsonl')):
        raw = file.read_bytes()
        events = [json.loads(line) for line in raw.splitlines() if line.strip()]
        thread = next((e['payload']['thread_id'] for e in events if e['type']=='token_usage_record'), None)
        files.append({'path':str(file.relative_to(trial)), 'sha256':hashlib.sha256(raw).hexdigest()})
        for event in events:
            p = event.get('payload', {})
            if event['type'] == 'token_usage_record':
                u = usage(p.get('usage'))
                if u is None or not p.get('response_id') or not p.get('thread_id'):
                    invalid.append({'actor':actor.name,'kind':'invalid_request'})
                    continue
                value = {'actor':actor.name,'thread':p['thread_id'],'usage':u}
                if p['response_id'] in requests and requests[p['response_id']] != value:
                    raise ValueError('conflicting response ID')
                requests[p['response_id']] = value
                total = usage(p.get('thread_token_usage'))
                if total is not None:
                    snapshots[(p['thread_id'],'request_counter')].append((event.get('timestamp',''),total))
            elif event['type']=='event_msg' and p.get('type')=='token_count' and thread:
                total = usage(p.get('info',{}).get('total_token_usage'))
                if total is not None:
                    snapshots[(thread,'event_counter')].append((event.get('timestamp',''),total))
per_actor = collections.defaultdict(lambda: dict.fromkeys(fields,0))
per_thread = collections.defaultdict(lambda: dict.fromkeys(fields,0))
for r in requests.values():
    for k in fields:
        per_actor[r['actor']][k] += r['usage'][k]
        per_thread[r['thread']][k] += r['usage'][k]
known = {k:sum(r['usage'][k] for r in requests.values()) for k in fields}
known['uncached_input_tokens'] = known['input_tokens'] - known['cached_input_tokens']
thread_checks = []
for thread, summed in per_thread.items():
    for kind in ('request_counter','event_counter'):
        candidates = snapshots[(thread,kind)]
        latest_time = max((t for t,u in candidates),default=None)
        latest = [u for t,u in candidates if t==latest_time]
        thread_checks.append({'thread':thread,'kind':kind,'latest_timestamp':latest_time,'matches_sum':bool(latest) and all(u==summed for u in latest),'summed':summed,'latest_snapshots':latest})
expected = {r['task_id'] for r in inventory}
matched = known==accounting['known_usage'] and dict(per_actor)==accounting['per_actor'] and len(requests)==accounting['unique_requests']
result = {'arithmetic_status':'matched' if matched else 'mismatch','method':'Independent Python enumeration and unique-response summation. Latest-by-timestamp cumulative snapshots compared separately to per-thread sum. No call to production accounting implementation.','files':files,'known_usage':known,'unique_requests':len(requests),'per_actor':dict(per_actor),'thread_checks':thread_checks,'invalid':invalid,'expected_actors_without_usage':sorted(expected-per_actor.keys()),'unexpected_actors':sorted(per_actor.keys()-expected),'reported_usage_complete':accounting['usage_complete'],'reported_incomplete_actors':accounting['incomplete_actors'],'accounting_sha256':hashlib.sha256((trial/'accounting.json').read_bytes()).hexdigest(),'limitations':['Arithmetic equality does not establish lifecycle completion or recover missing usage.','Known usage remains a lower bound for incomplete trials; no missing actor or response imputed to zero.']}
(trial/'usage-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'trial':trial.name,'arithmetic_status':result['arithmetic_status'],'counter_mismatches':sum(not r['matches_sum'] for r in thread_checks),'reported_usage_complete':result['reported_usage_complete']}))
