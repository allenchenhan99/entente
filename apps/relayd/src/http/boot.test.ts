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
  it('RELAY_HOST=fake npx tsx apps/relayd/src/index.ts prints the listening line and the session token within 5 s, serves /health, and guards /runs with the token', async () => {
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
      // Session token: printed once, written 0600, required on /runs (always) but not on /state (RELAY_AUTH default optional).
      const tokens = [...output.matchAll(/relayd token: ([0-9a-f]{32})/g)].map((m) => m[1]!);
      expect(tokens).toHaveLength(1);
      const tokenFile = path.join(repo, '.relay', 'session.token');
      expect(fs.readFileSync(tokenFile, 'utf8')).toBe(tokens[0]);
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect((await fetch(`${line}/runs`)).status).toBe(401);
      expect((await fetch(`${line}/runs`, { headers: { authorization: `Bearer ${tokens[0]}` } })).status).toBe(200);
      expect((await fetch(`${line}/state`)).status).toBe(200);
    } finally {
      killGroup(child.pid);
      await child;
    }
  }, 15_000);
});
