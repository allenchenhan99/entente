import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

const ROOT = path.resolve(__dirname, '../../../..');

/** SIGTERM the detached child's whole process group, so the `sh` and `node` under `npx` go too. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

describe('boot', () => {
  it('RELAY_HOST=fake npx tsx apps/relayd/src/index.ts prints the listening line within 5 s and serves /health', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
    // `npx` runs relayd as `sh -c tsx …` → node, and neither wrapper forwards signals. Killing only the
    // `npx` pid leaves the real node process alive holding the inherited stdout pipe, so `all` never ends
    // and the `await child` below hangs until the test times out. Run it in its own process group and
    // signal the whole group instead.
    const child = execa('npx', ['tsx', 'apps/relayd/src/index.ts'], {
      cwd: ROOT,
      env: { RELAY_HOST: 'fake', RELAY_PORT: '0', RELAY_REPO: repo, RELAY_RUN_ID: 'boot-test' },
      reject: false,
      all: true,
      detached: true,
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
      killGroup(child.pid);
      await child;
    }
  }, 15_000);
});
