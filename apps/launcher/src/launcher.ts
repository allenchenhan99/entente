import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';

import { DEFAULT_PORT } from '@relay/protocol';

export type LauncherCommand = 'up' | 'status' | 'down';
export type LauncherHost = 'relay' | 'herdr' | 'tmux';

export interface LauncherOptions {
  command: LauncherCommand;
  repo: string;
  relayDir: string;
  relayDirExplicit?: true;
  port: number;
  host: LauncherHost;
  replay?: string;
  noSpawn: boolean;
}

export type ParsedArgs = LauncherOptions | { command: 'help' };

export class UsageError extends Error {}

const HOSTS: readonly LauncherHost[] = ['relay', 'herdr', 'tmux'];

function portNumber(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(`--port must be an integer from 1 to 65535, got ${value}`);
  }
  return port;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): ParsedArgs {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        dir: { type: 'string' },
        replay: { type: 'string' },
        'no-spawn': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  if (parsed.values.help) return { command: 'help' };

  const positionals = [...parsed.positionals];
  const first = positionals.shift();
  let command: LauncherCommand;
  if (first === undefined || first === 'up') command = 'up';
  else if (first === 'status' || first === 'down') command = first;
  else if (first === 'help') return { command: 'help' };
  else throw new UsageError(`unknown command: ${first}`);
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);

  const host = parsed.values.host ?? 'relay';
  if (!HOSTS.includes(host as LauncherHost)) {
    throw new UsageError(`--host must be one of ${HOSTS.join('|')}, got ${host}`);
  }
  const repo = path.resolve(cwd, parsed.values.repo ?? '.');
  const explicitDir = parsed.values.dir === undefined ? undefined : path.resolve(cwd, parsed.values.dir);

  return {
    command,
    repo,
    relayDir: explicitDir ?? path.join(repo, '.relay'),
    ...(explicitDir === undefined ? {} : { relayDirExplicit: true as const }),
    port: portNumber(parsed.values.port),
    host: host as LauncherHost,
    ...(parsed.values.replay === undefined ? {} : { replay: parsed.values.replay }),
    noSpawn: parsed.values['no-spawn'] ?? false,
  };
}
