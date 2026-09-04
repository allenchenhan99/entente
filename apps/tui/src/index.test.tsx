import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseCliArgs, renderHeadlessFrames, runCli, type OutputStream } from './index.js';

const repairFixture = fileURLToPath(new URL('../../../fixtures/events-repair.jsonl', import.meta.url));

describe('headless CLI', () => {
  it('parses defaults', () => {
    expect(parseCliArgs([], {})).toEqual({
      url: 'http://127.0.0.1:7420',
      speed: 1,
      frames: 1,
      noTty: false,
      focusCmd: 'relay',
    });
  });

  it('parses every supported flag and rejects invalid values', () => {
    expect(parseCliArgs([
      '--url', 'http://relay.test:9000/',
      '--replay', repairFixture,
      '--speed', '4',
      '--frames', '2',
      '--no-tty',
      '--focus-cmd', 'none',
    ], {})).toEqual({
      url: 'http://relay.test:9000/',
      replayFile: repairFixture,
      speed: 4,
      frames: 2,
      noTty: true,
      focusCmd: 'none',
    });
    expect(() => parseCliArgs(['--speed', '0'], {})).toThrow('positive');
    expect(() => parseCliArgs(['--focus-cmd', 'screen'], {})).toThrow('focus-cmd');
    expect(() => parseCliArgs(['--wat'], {})).toThrow('Unknown option');
  });

  it.each([
    ['node:planner', { kind: 'node', id: 'planner' }],
    ['edge:contract-backend', { kind: 'edge', id: 'contract-backend' }],
    ['inbox:question-1', { kind: 'inbox', id: 'question-1' }],
  ] as const)('parses --select %s as a GraphObjectRef', (value, selected) => {
    expect(parseCliArgs(['--select', value], {}).selected).toEqual(selected);
  });

  it('rejects malformed --select references', () => {
    expect(() => parseCliArgs(['--select', 'task:backend'], {})).toThrow('--select');
    expect(() => parseCliArgs(['--select', 'node:'], {})).toThrow('--select');
    expect(parseCliArgs(['--select', 'node:backend:extra'], {}).selected).toEqual({
      kind: 'node',
      id: 'backend:extra',
    });
  });

  it('renders deterministic repair replay frames as plain text with at least 20 lines', () => {
    const options = parseCliArgs(['--replay', repairFixture, '--frames', '2', '--no-tty'], {});
    const frames = renderHeadlessFrames(options, { width: 100, height: 30 });

    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.split('\n').length).toBeGreaterThanOrEqual(20);
      expect(frame).not.toMatch(/\u001b\[/);
      expect(frame).toContain('MISSION / WORKTREES');
      expect(frame).toContain('TIMELINE');
    }
    expect(frames[0]).toContain('AC-2');
  });

  it('automatically uses headless mode when stdout is not a TTY', async () => {
    let output = '';
    const stdout: OutputStream = {
      isTTY: false,
      columns: 100,
      rows: 30,
      write(chunk) {
        output += chunk;
        return true;
      },
    };

    const exitCode = await runCli(['--replay', repairFixture, '--frames', '1'], {}, stdout);
    expect(exitCode).toBe(0);
    expect(output.split('\n').length).toBeGreaterThanOrEqual(20);
    expect(output).not.toMatch(/\u001b\[/);
  });
});
