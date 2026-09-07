import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('review_check', pathlib.Path(__file__).with_name('reconcile-reviews.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReviewEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        trial = self.root / '01-test'
        self.subject = trial / 'subject'
        self.subject.mkdir(parents=True)
        def git(*args):
            return subprocess.check_output(['git', *args], cwd=self.subject, stderr=subprocess.DEVNULL).decode().strip()
        git('init', '-q')
        (self.subject / 'rule.txt').write_text('real rule\n')
        git('add', 'rule.txt')
        git('-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'fixture')
        commit = git('rev-parse', 'HEAD')
        self.calls = [{'actor': actor, 'call_id': str(i), 'input_sha256': f'input{i}', 'output_sha256': f'output{i}'} for i, actor in enumerate(['owner', 'child', 'child'])]
        native = [{'actor': 'owner', 'id': 'n1', 'sha256': 'receipt', 'arguments': {}}]
        (trial / 'access-ledger.json').write_text(json.dumps(self.calls))
        (trial / 'native-mcp-ledger.json').write_text(json.dumps(native))
        self.review = {'trials': [{'trial': '01-test', 'artifact_hashes': {}, 'calls': self.calls, 'native_review': [{'actor': 'owner', 'id': 'n1', 'receipt_sha256': 'receipt', 'arguments': {}}], 'acquisitions': [{**c, 'path': 'rule.txt', 'source_commit': commit, 'source_sha256': module.sha(b'real rule\n')} for c in self.calls]}]}
        self.report = self.root / 'review.json'

    def run_review(self):
        self.report.write_text(json.dumps(self.review))
        return module.reconcile(self.root, [self.report])

    def test_exposure_separates_workflow_actor_and_repeat(self):
        counts = self.run_review()['trials'][0]['counts']
        self.assertEqual(counts, {'first_workflow_read_of_source_version': 1, 'first_actor_read_of_previously_seen_source': 1, 'same_actor_previous_call_same_source': 1})

    def test_missing_output_is_not_acquired(self):
        self.review['trials'][0]['acquisitions'][1]['confirmed_acquisition'] = False
        counts = self.run_review()['trials'][0]['counts']
        self.assertEqual(counts['unconfirmed_output'], 1)
        self.assertNotIn('same_actor_previous_call_same_source', counts)

    def test_duplicate_annotations_rejected(self):
        self.review['trials'][0]['calls'].append(self.calls[0])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.run_review()

    def test_missing_call_rejected(self):
        self.review['trials'][0]['calls'].pop()
        with self.assertRaisesRegex(ValueError, 'coverage mismatch'):
            self.run_review()

    def test_source_hash_checked_against_git(self):
        self.review['trials'][0]['acquisitions'][0]['source_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'source hash mismatch'):
            self.run_review()

    def test_artifact_change_rejected(self):
        self.review['trials'][0]['artifact_hashes']['access-ledger.json'] = {'sha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'artifact changed'):
            self.run_review()


if __name__ == '__main__':
    unittest.main()
