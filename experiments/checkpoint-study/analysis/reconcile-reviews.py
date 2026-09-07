"""Validate review identities/hashes and recompute comparable source exposure counts.

This checks evidence coverage, not the truth of a reviewer's semantic judgments.
"""
import collections
import hashlib
import json
import pathlib
import subprocess
import sys


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique(rows, identity):
    out = {}
    for row in rows:
        key = identity(row)
        if key in out:
            raise ValueError(f'duplicate review identity: {key}')
        out[key] = row
    return out


def reconcile(study, reports):
    trials = []
    covered = set()
    for report_path in reports:
        report = json.loads(report_path.read_text())
        for review in report['trials']:
            name = review['trial']
            if name in covered or pathlib.Path(name).name != name:
                raise ValueError(f'duplicate or unsafe trial: {name}')
            covered.add(name)
            root = study / name
            for filename, expected in review['artifact_hashes'].items():
                if pathlib.Path(filename).name != filename:
                    raise ValueError(f'unsafe artifact: {filename}')
                if sha((root / filename).read_bytes()) != expected['sha256']:
                    raise ValueError(f'artifact changed: {name}/{filename}')
            outer = json.loads((root / 'access-ledger.json').read_text())
            native = json.loads((root / 'native-mcp-ledger.json').read_text())
            calls = unique(outer, lambda x: (x['actor'], x['call_id']))
            annotated = unique(review['calls'], lambda x: (x['actor'], x['call_id']))
            if calls.keys() != annotated.keys():
                raise ValueError(f'outer coverage mismatch: {name}')
            for key, call in calls.items():
                for field in ['input_sha256', 'output_sha256']:
                    if call[field] != annotated[key][field]:
                        raise ValueError(f'call hash mismatch: {key}/{field}')
            receipts = unique(native, lambda x: (x['actor'], x['id']))
            reviewed = unique(review['native_review'], lambda x: (x['actor'], x.get('id', x.get('receipt_id'))))
            if receipts.keys() != reviewed.keys():
                raise ValueError(f'native coverage mismatch: {name}')
            for key, receipt in receipts.items():
                if receipt['sha256'] != reviewed[key]['receipt_sha256'] or receipt['arguments'] != reviewed[key]['arguments']:
                    raise ValueError(f'native receipt mismatch: {key}')

            order = {(c['actor'], c['call_id']): i for i, c in enumerate(outer)}
            rows = sorted(enumerate(review['acquisitions']), key=lambda pair: (order[(pair[1]['actor'], pair[1]['call_id'])], pair[0]))
            counts = collections.Counter()
            exposure = []
            seen_actor = set()
            seen_workflow = set()
            grouped = collections.defaultdict(list)
            for index, row in rows:
                grouped[(row['actor'], row['call_id'])].append((index, row))
            blobs = {}
            for key, group in grouped.items():
                additions = []
                for index, row in group:
                    record = {'review_index': index, 'actor': row['actor'], 'call_id': row['call_id'], 'path': row['path']}
                    digest = row.get('source_sha256')
                    if not digest or row.get('successful_acquisitions') == 0:
                        category = 'failed_lookup'
                    else:
                        commit = row.get('source_commit_verified') or row['source_commit']
                        blob_key = (commit, row['path'])
                        if blob_key not in blobs:
                            blobs[blob_key] = sha(subprocess.check_output(['git', 'show', f'{commit}:{row["path"]}'], cwd=root / 'subject', timeout=10))
                        if blobs[blob_key] != digest:
                            raise ValueError(f'source hash mismatch: {name}/{blob_key}')
                        record.update(source_commit=commit, source_sha256=digest)
                        if row.get('confirmed_acquisition') is False:
                            category = 'unconfirmed_output'
                        else:
                            source = (row['path'], digest)
                            actor_source = (row['actor'], *source)
                            if actor_source in seen_actor:
                                category = 'same_actor_previous_call_same_source'
                            elif source in seen_workflow:
                                category = 'first_actor_read_of_previously_seen_source'
                            else:
                                category = 'first_workflow_read_of_source_version'
                            additions.append((actor_source, source))
                    record['exposure'] = category
                    counts[category] += 1
                    exposure.append(record)
                # No arbitrary order is inferred for multiple acquisitions in one outer call.
                for actor_source, source in additions:
                    seen_actor.add(actor_source)
                    seen_workflow.add(source)
            trials.append({'trial': name, 'review_sha256': sha(report_path.read_bytes()), 'outer_calls': len(calls), 'native_receipts': len(receipts), 'counts': dict(counts), 'source_exposure': exposure, 'review_unresolved': review.get('unresolved', [])})
    return {'status': 'matched', 'method': 'Review artifact, call identity/hash, native receipt and Git blob checks; uniform prior-call source exposure, independently of reviewer category labels.', 'limits': ['This is not an independent semantic interpretation of every command.', 'Source exposure counts are not avoidable waste or marginal model cost.', 'Within-call ordering is not inferred; only previous calls count as prior exposure.', 'Failed lookup and missing returned output are not successful acquisitions.'], 'trials': sorted(trials, key=lambda x: x['trial'])}


if __name__ == '__main__':
    study = pathlib.Path(sys.argv[1]).resolve()
    reports = [pathlib.Path(p).resolve() for p in sys.argv[2:-1]]
    result = reconcile(study, reports)
    pathlib.Path(sys.argv[-1]).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'trials': len(result['trials']), 'outer_calls': sum(t['outer_calls'] for t in result['trials']), 'native_receipts': sum(t['native_receipts'] for t in result['trials'])}))
