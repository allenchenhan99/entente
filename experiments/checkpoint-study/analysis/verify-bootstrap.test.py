"""Adversarial checks against a disposable one-actor copy of a retained trial."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

study = pathlib.Path(sys.argv[1]).resolve()
repo = pathlib.Path(sys.argv[2]).resolve()
script = pathlib.Path(__file__).with_name('verify-bootstrap.mjs')
source = study / '01-evidence-service-17-task-only'
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    shutil.copyfile(study / 'summary.json', root / 'summary.json')
    trial = root / source.name
    trial.mkdir()
    shutil.copyfile(source / 'native-mcp-ledger.json', trial / 'native-mcp-ledger.json')
    destination = trial / 'subject/.relay/agents/t-owner/sessions'
    shutil.copytree(source / 'subject/.relay/agents/t-owner/sessions', destination)
    files = list(destination.rglob('rollout-*.jsonl'))
    originals = {file: file.read_bytes() for file in files}

    def run():
        return subprocess.run(['node', str(script), str(root), str(repo)], capture_output=True, text=True)

    assert run().returncode == 0, 'unchanged fixture must match'
    edited = False
    for file in files:
        events = [json.loads(line) for line in file.read_text().splitlines()]
        for event in events:
            payload = event.get('payload', {})
            if event.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'user':
                if any('You are the recipient agent' in c.get('text', '') for c in payload['content']):
                    payload['content'][0]['text'] += '\nExtra noncanonical task hint.'
                    edited = True
                    break
        if edited:
            file.write_text(''.join(json.dumps(e) + '\n' for e in events))
            break
    assert edited and run().returncode != 0, 'changed bootstrap must fail'
    for file, data in originals.items():
        file.write_bytes(data)
    with files[0].open('a') as file:
        file.write(json.dumps({'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'An additional task answer.'}]}}) + '\n')
    assert run().returncode != 0, 'additional user prompt must fail'
print(json.dumps({'passed': 3, 'checks': ['canonical initial bootstrap', 'changed bootstrap rejected', 'additional user message rejected']}))
