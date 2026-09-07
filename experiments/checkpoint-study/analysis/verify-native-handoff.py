"""Verify the retained two-child native handoff; never launch or modify agents.

Usage: python3 verify-native-handoff.py NATIVE_REPO OUTPUT_JSON
The output proves recorded mechanics, not semantic correctness or efficiency.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(repo):
    relay = repo / '.relay/native-live'
    events_files = sorted((relay / 'runs').glob('*/events.jsonl'))
    assert len(events_files) == 1, 'expected one retained run'
    events = [json.loads(line) for line in events_files[0].read_text().splitlines()]
    mission = next(e['mission_id'] for e in events if e['type'] == 'mission_created')
    assert all(e['mission_id'] == mission for e in events), 'mixed missions'
    assert any(e['type'] == 'mission_verified' for e in events), 'mission not verified'
    tasks = ['t-continuous-owner', 't-baseline-review', 't-readiness-verify']
    for task in tasks:
        for kind in ['task_verified', 'task_completed']:
            assert any(e['type'] == kind and e.get('task_id') == task for e in events), (task, kind)
    assert not any(e['type'] in ['task_canceled', 'mission_canceled'] for e in events)
    checkpoint = relay / 'checkpoints'
    operations_file = checkpoint / 'operations.jsonl'
    operations = [json.loads(line) for line in operations_file.read_text().splitlines()]

    def response(op):
        file = checkpoint / 'responses' / (digest(op['output_sha256'].encode()) + '.json')
        data = file.read_bytes()
        assert digest(data) == op['output_sha256'], 'response digest mismatch'
        return json.loads(data)

    def git(*args):
        return subprocess.check_output(['git', *args], cwd=repo)

    owner = 'mission:' + mission + ':task:t-continuous-owner'
    ledger = json.loads((checkpoint / 'owners' / (digest(owner.encode()) + '.json')).read_text())
    history, cursor = [], ledger.get('history_head')
    seen = set()
    while cursor:
        assert cursor not in seen, 'history cycle'
        seen.add(cursor)
        data = (checkpoint / 'history' / (digest(cursor.encode()) + '.json')).read_bytes()
        assert digest(data) == cursor, 'history digest mismatch'
        record = json.loads(data)
        assert record['state']['owner'] == owner
        history.append(record)
        cursor = record.get('previous')

    proposals = [o for o in operations if o['operation'] == 'propose' and o['actor'] == 't-baseline-review' and o['status'] == 'ok']
    assert len(proposals) == 1, 'expected one final review-child proposal'
    proposal = response(proposals[0])
    assert proposal['upsert'], 'empty finding'
    accepted = next(h for h in history if h['operation'] == 'accept' and h.get('proposal_id') == proposal['id'])
    contracts = [e['payload']['contract'] for e in events if e['type'] == 'task_proposed' and e.get('task_id') == 't-readiness-verify']
    assert len(contracts) == 1, 'expected first-proposal success without input workaround'
    contract = contracts[0]
    packet_file = checkpoint / 'packets' / (digest((contract['context_id'] + ':' + str(contract['version'])).encode()) + '.json')
    bound_packet = json.loads(packet_file.read_text())
    report = 'docs/research/native-parent-baseline-review.md'
    assert report in contract['inputs']
    assert not any(p.startswith('.relay/') for p in contract['inputs'])
    child_creation = next(e for e in events if e['type'] == 'worktree_created' and e.get('task_id') == 't-readiness-verify')
    base = child_creation['payload']['base']
    initial = next(e['payload']['base'] for e in events if e['type'] == 'worktree_created' and e.get('task_id') == 't-continuous-owner')
    assert git('rev-parse', 'HEAD').decode().strip() == initial, 'root HEAD advanced'
    assert git('ls-tree', initial, '--', report) == b'', 'report existed in root baseline'
    packets, matched = [], []
    for op in operations:
        if op['status'] != 'ok' or op['operation'] not in ['assign', 'lookup']:
            continue
        packet = response(op)
        if packet.get('owner') != owner:
            continue
        if op['operation'] == 'lookup' and op['actor'] != 't-readiness-verify':
            continue
        if all(any(all(entry.get(k) == fact[k] for k in ['id', 'text', 'tags', 'sources']) for entry in packet['entries']) for fact in proposal['upsert']):
            assert packet['revision'] == accepted['state']['revision']
            for fact in proposal['upsert']:
                entry = next(e for e in packet['entries'] if e['id'] == fact['id'])
                assert entry['source_status'] == 'current'
                assert fact['id'] in contract['context']['ids']
                for source in fact['sources']:
                    assert digest(git('show', base + ':' + source['path'])) == source['sha256']
            packets.append(packet)
            matched.append(op)
    assert {'assign', 'lookup'} <= {op['operation'] for op in matched}, 'missing exact delivery/lookup'
    assert any(packet == bound_packet for packet in packets), 'bound contract packet differs'
    assert any(h['operation'] == 'accept' and any(p['id'] == h.get('proposal_id') and p['author'] == 't-readiness-verify' for prior in history for p in prior['state']['proposals']) for h in history), 'final verifier finding not accepted'
    return {
        'status': 'verified_recorded_native_handoff', 'mission_id': mission,
        'repo': str(repo), 'initial_root_head': initial, 'root_head_unchanged': True,
        'second_child_base': base, 'ordinary_parent_relative_report_input': report,
        'proposal': proposal, 'accepted_revision': accepted['state']['revision'],
        'exact_packet': packets[0], 'receipts': [proposals[0], *matched],
        'final_owner_revision': ledger['revision'],
        'evidence_hashes': {str(p.relative_to(repo)): digest(p.read_bytes()) for p in [events_files[0], operations_file, packet_file]},
        'limits': ['Recorded state proves exact transfer and source presence, not semantic truth.', 'Read the verifier and owner reports to assess actual use and disclosed errors.', 'No efficiency claim follows from this workflow verification.'],
    }


if __name__ == '__main__':
    result = verify(Path(sys.argv[1]).resolve())
    Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'mission_id': result['mission_id']}))
