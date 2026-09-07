"""Independently reconcile raw rollout calls against exported audit ledgers.
Does not perform semantic classification or assert unrecorded activity absent.
"""
import collections
import hashlib
import json
import pathlib
import sys

trial = pathlib.Path(sys.argv[1]).resolve()
outer = {}
native = {}
files = []
conflicts = []
for actor in sorted((trial / 'subject/.relay/agents').iterdir()):
    if not actor.is_dir():
        continue
    for file in sorted(actor.rglob('rollout-*.jsonl')):
        raw = file.read_bytes()
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        messages = []
        counts = collections.Counter()
        for row in rows:
            payload = row.get('payload', {})
            kind = payload.get('type')
            counts[str((row['type'], kind))] += 1
            if row['type'] == 'response_item' and kind in ('custom_tool_call', 'function_call'):
                key = (actor.name, payload['call_id'])
                value = {'tool': payload['name'], 'input': payload.get('input', payload.get('arguments'))}
                if key in outer and outer[key] != value:
                    conflicts.append({'kind': 'outer', 'actor': key[0], 'id': key[1]})
                outer[key] = value
            if row['type'] == 'event_msg' and kind == 'item_completed' and payload.get('item', {}).get('type') == 'McpToolCall':
                item = payload['item']
                key = (actor.name, item['id'])
                value = {k: item.get(k) for k in ('tool', 'server', 'status', 'arguments', 'result')}
                if key in native and native[key] != value:
                    conflicts.append({'kind': 'native', 'actor': key[0], 'id': key[1]})
                native[key] = value
            if row['type'] == 'response_item' and kind == 'message':
                text = '\n'.join(c.get('text', '') for c in payload.get('content', []))
                messages.append({'role': payload.get('role'), 'sha256': hashlib.sha256(text.encode()).hexdigest(), 'characters': len(text)})
        files.append({'actor': actor.name, 'path': str(file.relative_to(trial)), 'sha256': hashlib.sha256(raw).hexdigest(), 'events': dict(counts), 'messages': messages})

def compare(raw, path, key_name, fields):
    rows = json.loads(path.read_text())
    exported = {(r['actor'], r[key_name]): {k: r.get(k) for k in fields} for r in rows}
    return {
        'raw_unique': len(raw), 'exported_unique': len(exported),
        'exported_duplicate_count': len(rows) - len(exported),
        'missing': [list(k) for k in sorted(raw.keys() - exported.keys())],
        'extra': [list(k) for k in sorted(exported.keys() - raw.keys())],
        'different': [list(k) for k in sorted(raw.keys() & exported.keys()) if raw[k] != exported[k]],
        'ledger_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    }

outer_result = compare(outer, trial / 'access-ledger.json', 'call_id', ('tool', 'input'))
native_result = compare(native, trial / 'native-mcp-ledger.json', 'id', ('tool', 'server', 'status', 'arguments', 'result'))
matched = not conflicts and all(not r[k] for r in (outer_result, native_result) for k in ('missing', 'extra', 'different', 'exported_duplicate_count'))
result = {'status': 'matched' if matched else 'mismatch', 'method': 'Independent raw JSONL enumeration; exact actor/call identity and payload equality, without executing logged commands.', 'semantic_review': 'not_performed_by_this_script', 'files': files, 'outer': outer_result, 'native': native_result, 'conflicts': conflicts}
(trial / 'rollout-coverage.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'trial': trial.name, 'status': result['status'], 'outer': outer_result, 'native': native_result, 'conflicts': conflicts}))
