import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

const ROOT = path.resolve(__dirname, '../../../..');

describe('boot', () => {
  it('RELAY_HOST=fake npx tsx apps/relayd/src/index.ts prints the listening line within 5 s and serves /health', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    const child = execa('npx', ['tsx', 'apps/relayd/src/index.ts'], {
      cwd: ROOT,
      env: { RELAY_HOST: 'fake', RELAY_PORT: '0', RELAY_REPO: repo, RELAY_RUN_ID: 'boot-test' },
      reject: false,
      all: true,
    });
    let output = '';
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line within 5 s; output so far:\n${output}`)), 5000);
      child.all!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const m = output.match(/relayd listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      void child.then(() => {
        clearTimeout(timer);
        reject(new Error(`relayd exited early:\n${output}`));
      });
    });
    try {
      expect(line).not.toMatch(/:0$/);
      const health = await fetch(`${line}/health`);
      expect(await health.json()).toEqual({ ok: true, version: expect.any(String) });
      expect(fs.existsSync(path.join(repo, '.relay', 'runs', 'boot-test', 'events.jsonl'))).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await child;
    }
  }, 15_000);
});
