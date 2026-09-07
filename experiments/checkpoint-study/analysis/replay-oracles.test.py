"""Adversarial replay checks using a disposable copy of one supplied trial archive."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

source = pathlib.Path(sys.argv[1]).resolve()
script = pathlib.Path(__file__).with_name('replay-oracles.mjs')
with tempfile.TemporaryDirectory(prefix='checkpoint-replay-test-') as directory:
    root = pathlib.Path(directory).resolve()
    for name in ('manifest.json', 'private-fixture.json'):
        shutil.copyfile(source / name, root / name)
    shutil.copytree(source / 'step-1', root / 'step-1')
    shutil.copytree(source / 'step-1', root / 'subject')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root / 'subject', stderr=subprocess.PIPE, text=True)
    git('init', '-q')
    git('add', '--all')
    git('-c', 'user.name=Replay verifier', '-c', 'user.email=replay@local.invalid', 'commit', '-qm', 'Disposable archive fixture')
    commit = git('rev-parse', 'HEAD').strip()
    quality = json.loads((source / 'result.json').read_text())['quality'][0]
    quality['commit'] = commit
    baseline = {'status':'finished', 'quality':[quality]}
    def replay(result=baseline):
        (root / 'result.json').write_text(json.dumps(result))
        return subprocess.run(['node', str(script), str(root)], capture_output=True, text=True, timeout=30)
    positive = replay()
    assert positive.returncode == 0, positive.stderr
    assert json.loads(positive.stdout)['status'] == 'matched', (root / 'oracle-replay.json').read_text()
    module = next((root / 'step-1/src').glob('*.mjs'))
    original = module.read_bytes()
    module.write_bytes(original + b'\n// modified archive\n')
    altered = replay()
    assert altered.returncode != 0 and 'archive differs from committed tree' in altered.stderr
    module.write_bytes(original)
    wrong_result = json.loads(json.dumps(baseline))
    wrong_result['quality'][0]['passed'] = not quality['passed']
    mismatch = replay(wrong_result)
    assert mismatch.returncode == 0 and json.loads(mismatch.stdout)['status'] == 'mismatch'
    missing = replay({'status':'failed','quality':[{'step':1,'status':'not_archived'}]})
    assert missing.returncode == 0 and json.loads(missing.stdout)['status'] == 'not_replayed'
    running = replay({'status':'running','quality':[]})
    assert running.returncode != 0 and 'only terminal trials' in running.stderr
print(json.dumps({'passed':5,'checks':['unchanged archive matches','modified archive rejected','changed reported result detected','zero archived steps not passed','live trial rejected'],'source_trial':source.name}))
