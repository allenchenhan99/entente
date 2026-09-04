import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { TaskContract } from '@relay/protocol';
import { loadConfig } from '../config.js';
import { createTerminalHost } from '../launch/index.js';
import { createRelayHost as fromRelayFile } from '../launch/hosts/relay.js';
import { resolvePorts } from '../index.js';
import { createJsonlStore } from '../store/jsonl-store.js';
import { createOrchestrator } from '../orchestrator/orchestrator.js';
import { fakeChecks, fakeRepair, fakeRuntime } from '../fakes/index.js';
import type { WorktreeManager, WorktreeInfo } from '../ports.js';
import { RelayHost, createRelayHost } from './host.js';
import { sampleContract } from '../fakes/test-harness.js';

const ROOT = path.resolve(__dirname, '../../../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
const hosts: RelayHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.killAll(50);
});

describe('relay host wiring', () => {
  it('config accepts RELAY_HOST=relay', () => {
    expect(loadConfig({ RELAY_HOST: 'relay', RELAY_REPO: '/r' }).host).toBe('relay');
  });

  it('createTerminalHost("relay", { relayDir, runId }) returns the relay host; launch/hosts/relay.ts re-exports it', () => {
    const dir = tmp();
    const host = createTerminalHost('relay', { relayDir: path.join(dir, '.relay'), runId: 'r1' });
    expect(host.kind).toBe('relay');
    expect(host).toBeInstanceOf(RelayHost);
    expect(fromRelayFile).toBe(createRelayHost);
    expect(() => createTerminalHost('relay', {})).toThrow(/relayDir/);
  });

  it('resolvePorts passes relayDir and runId to the relay host', async () => {
    const dir = tmp();
    const cfg = loadConfig({ RELAY_HOST: 'relay', RELAY_REPO: dir, RELAY_RUN_ID: 'r1' });
    const ports = await resolvePorts(cfg, createJsonlStore({ dir: path.join(dir, 'run') }), () => {});
    expect(ports.host.kind).toBe('relay');
    expect(ports.fakes).not.toContain('host');
    const host = ports.host as unknown as RelayHost;
    hosts.push(host);
    const { paneId } = await host.spawn({ name: 'x', cwd: dir, argv: ['sh', '-c', 'read x'], env: {} });
    expect(host.list()[0]!.cast_path).toBe(path.join(dir, '.relay', 'runs', 'r1', 'casts', `${paneId}.cast`));
  });

  it('the orchestrator spawns a task through the relay host: agent_spawned.pane_id starts with relay:', async () => {
    const dir = tmp();
    const store = createJsonlStore({ dir: path.join(dir, 'run') });
    const host = createRelayHost({ relayDir: path.join(dir, '.relay'), runId: 'r1' });
    hosts.push(host);
    // Real PTYs need a real cwd: a worktree manager that hands out existing directories.
    const worktrees: WorktreeManager = {
      async create(_repo: string, task: TaskContract): Promise<WorktreeInfo> {
        const p = path.join(dir, 'wt', task.id);
        fs.mkdirSync(p, { recursive: true });
        return { path: p, branch: `relay/${task.id}`, base: 'main' };
      },
      async remove() {},
      async diff(worktreePath: string) { return { patchPath: `${worktreePath}.patch`, changedFiles: [] }; },
      async integrate() { return { branch: 'relay/integration' }; },
      async commitAll() { return { committed: false }; },
    };
    const claude = fakeRuntime('claude-code');
    const runtime = { ...claude, prepare: async (spec: Parameters<typeof claude.prepare>[0], configDir: string) => ({ ...(await claude.prepare(spec, configDir)), argv: ['sh', '-c', 'sleep 30'] }) };
    const orchestrator = createOrchestrator({
      store, worktrees, checks: fakeChecks({}, store), repair: fakeRepair(), host: host as never,
      runtimes: { 'claude-code': runtime, codex: fakeRuntime('codex') }, repoRoot: dir, relayDir: path.join(dir, '.relay'), mcpUrl: 'http://127.0.0.1:0/mcp',
    });
    const { mission_id } = orchestrator.createMission({ repo: dir, title: 'Relay-hosted task' });
    const out = await orchestrator.proposeTask(mission_id, sampleContract('t-sleepy'), 'planner');
    expect(out.status).toBe('proposed');
    await orchestrator.settled();
    const spawned = store.all().find((e) => e.type === 'agent_spawned');
    expect(spawned).toBeDefined();
    const paneId = (spawned!.payload as { pane_id: string }).pane_id;
    expect(paneId).toMatch(/^relay:\d+$/);
    expect(await host.isAlive(paneId)).toBe(true);
    const info = host.get(paneId)!.info();
    expect(info.cwd).toBe(path.join(dir, 'wt', 't-sleepy'));
    expect(info.role).toBe('sleepy');
    expect(info.runtime).toBeUndefined();
    await orchestrator.cancel('t-sleepy', 'done testing');
    expect(await host.isAlive(paneId)).toBe(false);
  });
});

describe('relay host boot', () => {
  it('RELAY_HOST=relay npx tsx apps/relayd/src/index.ts serves GET /panes → {"panes":[]} with the session token and refuses a WS upgrade without it', async () => {
    const repo = tmp();
    const child = execa('npx', ['tsx', 'apps/relayd/src/index.ts'], {
      cwd: ROOT, env: { RELAY_HOST: 'relay', RELAY_PORT: '0', RELAY_REPO: repo, RELAY_RUN_ID: 'boot-relay' }, reject: false, all: true, detached: true,
    });
    let output = '';
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line within 8 s; output so far:\n${output}`)), 8000);
      child.all!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const m = output.match(/relayd listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) { clearTimeout(timer); resolve(m[1]!); }
      });
      void child.then(() => { clearTimeout(timer); reject(new Error(`relayd exited early:\n${output}`)); });
    });
    try {
      expect(output).not.toMatch(/fakes for .*host/);
      const token = /relayd token: ([0-9a-f]{32})/.exec(output)?.[1];
      expect(token).toBeDefined();
      expect((await fetch(`${url}/panes`)).status).toBe(401);
      const panes = await fetch(`${url}/panes`, { headers: { authorization: `Bearer ${token}` } });
      expect(panes.status).toBe(200);
      expect(await panes.text()).toBe('{"panes":[]}');
      const { WebSocket } = await import('ws');
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`${url.replace('http', 'ws')}/pty/relay:1`);
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('open', () => reject(new Error('unexpected upgrade')));
        ws.once('error', reject);
      });
      expect(status).toBe(401);
      const withToken = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`${url.replace('http', 'ws')}/pty/relay:1`, [`relay.${token}`]);
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('open', () => reject(new Error('unexpected upgrade')));
        ws.once('error', reject);
      });
      expect(withToken).toBe(404);
    } finally {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
      }
      await child;
    }
  }, 20_000);
});
