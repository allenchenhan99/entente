import path from 'node:path';

import { DEFAULT_PORT } from '@relay/protocol';
import { describe, expect, it } from 'vitest';

import { parseArgs } from './launcher.js';

describe('parseArgs', () => {
  const cwd = path.resolve('/tmp', 'relay-launcher-repo');

  it('defaults to up in the current repository', () => {
    expect(parseArgs([], cwd)).toEqual({
      command: 'up',
      repo: cwd,
      relayDir: path.join(cwd, '.relay'),
      port: DEFAULT_PORT,
      host: 'relay',
      noSpawn: false,
    });
  });

  it('parses every up flag and resolves filesystem paths', () => {
    expect(parseArgs([
      'up', '--repo', 'project', '--port', '9001', '--host', 'herdr',
      '--dir', 'state', '--replay', 'fixtures/run.jsonl', '--no-spawn',
    ], cwd)).toEqual({
      command: 'up',
      repo: path.join(cwd, 'project'),
      relayDir: path.join(cwd, 'state'),
      relayDirExplicit: true,
      port: 9001,
      host: 'herdr',
      replay: 'fixtures/run.jsonl',
      noSpawn: true,
    });
  });

  it.each(['status', 'down'] as const)('parses the %s subcommand', (command) => {
    expect(parseArgs([command, '--repo', 'project', '--port', '8123'], cwd)).toMatchObject({
      command,
      repo: path.join(cwd, 'project'),
      relayDir: path.join(cwd, 'project', '.relay'),
      port: 8123,
    });
  });

  it('recognizes help without requiring a daemon', () => {
    expect(parseArgs(['--help'], cwd)).toEqual({ command: 'help' });
  });

  it('rejects unknown flags, commands, hosts, and ports as usage errors', () => {
    expect(() => parseArgs(['--wat'], cwd)).toThrow(/unknown option/i);
    expect(() => parseArgs(['restart'], cwd)).toThrow(/unknown command/i);
    expect(() => parseArgs(['--host', 'fake'], cwd)).toThrow(/--host/);
    expect(() => parseArgs(['--port', '0'], cwd)).toThrow(/--port/);
  });
});
