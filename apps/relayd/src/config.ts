/** relayd runtime configuration, read from the environment. */
import path from 'node:path';
import { DEFAULT_PORT } from '@relay/protocol';

export const RELAYD_VERSION = '0.0.1';

export type HostKind = 'tmux' | 'herdr' | 'relay' | 'fake';

export interface RelaydConfig {
  port: number;
  repoRoot: string;
  relayDir: string;
  host: HostKind;
  runId: string;
}

const HOSTS: HostKind[] = ['tmux', 'herdr', 'relay', 'fake'];

export function loadConfig(env: Record<string, string | undefined> = process.env): RelaydConfig {
  const repoRoot = path.resolve(env.RELAY_REPO ?? process.cwd());
  const relayDir = env.RELAY_DIR ? path.resolve(env.RELAY_DIR) : path.join(repoRoot, '.relay');
  const port = env.RELAY_PORT === undefined ? DEFAULT_PORT : Number(env.RELAY_PORT);
  if (!Number.isInteger(port) || port < 0) throw new Error(`RELAY_PORT must be a non-negative integer, got ${env.RELAY_PORT}`);
  const host = (env.RELAY_HOST ?? 'tmux') as HostKind;
  if (!HOSTS.includes(host)) throw new Error(`RELAY_HOST must be one of ${HOSTS.join('|')}, got ${env.RELAY_HOST}`);
  const runId = env.RELAY_RUN_ID ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return { port, repoRoot, relayDir, host, runId };
}

/** Directory holding this run's `events.jsonl` (PRD §13). */
export const runDir = (cfg: RelaydConfig): string => path.join(cfg.relayDir, 'runs', cfg.runId);
