import json
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('rollout-coverage.py')

class CoverageTests(unittest.TestCase):
    def test_missing_changed_duplicate_and_conflicting_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            sessions = root / 'subject/.relay/agents/owner/sessions'
            sessions.mkdir(parents=True)
            outer = {'type':'response_item', 'payload':{'type':'custom_tool_call','name':'exec','call_id':'call-1','input':'literal'}}
            item = {'type':'McpToolCall','id':'native-1','tool':'relay_get_context','server':'relay','status':'completed','arguments':{},'result':{'revision':2}}
            native = {'type':'event_msg','payload':{'type':'item_completed','item':item}}
            export = {'actor':'owner','call_id':'call-1','tool':'exec','input':'literal'}
            native_export = {'actor':'owner', **{k:v for k,v in item.items() if k!='type'}}
            def run(rows, calls, receipts):
                (sessions/'rollout-test.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
                (root/'access-ledger.json').write_text(json.dumps(calls))
                (root/'native-mcp-ledger.json').write_text(json.dumps(receipts))
                subprocess.run(['python3',str(SCRIPT),str(root)],check=True,capture_output=True)
                return json.loads((root/'rollout-coverage.json').read_text())
            self.assertEqual(run([outer,native],[export],[native_export])['status'],'matched')
            self.assertEqual(run([outer,native],[],[native_export])['outer']['missing'],[['owner','call-1']])
            altered={**native_export,'result':{'revision':3}}
            self.assertEqual(run([outer,native],[export],[altered])['native']['different'],[['owner','native-1']])
            self.assertEqual(run([outer,native],[export,export],[native_export])['status'],'mismatch')
            conflict={'type':'response_item','payload':{**outer['payload'],'input':'different'}}
            self.assertEqual(len(run([outer,conflict,native],[export],[native_export])['conflicts']),1)
            self.assertEqual(run([outer,outer,native],[export],[native_export])['status'],'matched')

if __name__ == '__main__':
    unittest.main()
