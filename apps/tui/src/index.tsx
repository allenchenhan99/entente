import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { initialState, replay } from '@relay/protocol';
import { render as renderInk } from 'ink';
import { render as renderForTest } from 'ink-testing-library';

import { App, RelayGraphApp } from './App.js';
import type { FocusCommand } from './commands.js';
import { DependenciesProvider } from './context.js';
import { loadJsonlFile } from './data/jsonl.js';

export interface CliOptions {
  url: string;
  replayFile?: string;
  speed: number;
  frames: number;
  noTty: boolean;
  focusCmd: FocusCommand;
}

export interface OutputStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(chunk: string): boolean;
}

interface HeadlessDimensions {
  width: number;
  height: number;
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function positiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${option} must be a positive number`);
  return parsed;
}

export function parseCliArgs(argv: string[], env: Record<string, string | undefined> = process.env): CliOptions {
  const options: CliOptions = {
    url: 'http://127.0.0.1:7420',
    speed: 1,
    frames: 1,
    noTty: false,
    focusCmd: env.HERDR_ENV === '1' ? 'herdr' : 'tmux',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option === '--no-tty') {
      options.noTty = true;
      continue;
    }
    if (option === '--url') {
      options.url = optionValue(argv, index, option);
      index += 1;
      continue;
    }
    if (option === '--replay') {
      options.replayFile = optionValue(argv, index, option);
      index += 1;
      continue;
    }
    if (option === '--speed') {
      options.speed = positiveNumber(optionValue(argv, index, option), option);
      index += 1;
      continue;
    }
    if (option === '--frames') {
      const frames = positiveNumber(optionValue(argv, index, option), option);
      if (!Number.isInteger(frames)) throw new Error('--frames must be a positive integer');
      options.frames = frames;
      index += 1;
      continue;
    }
    if (option === '--focus-cmd') {
      const command = optionValue(argv, index, option);
      if (command !== 'herdr' && command !== 'tmux' && command !== 'none') {
        throw new Error('--focus-cmd must be herdr, tmux, or none');
      }
      options.focusCmd = command;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${option}`);
  }
  return options;
}

function plainText(frame: string): string {
  return frame
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

export function renderHeadlessFrames(options: CliOptions, dimensions: HeadlessDimensions = { width: 100, height: 30 }): string[] {
  const sourceEvents = options.replayFile ? loadJsonlFile(options.replayFile) : [];
  return Array.from({ length: options.frames }, (_, index) => {
    const cursor = sourceEvents.length === 0
      ? 0
      : Math.max(1, Math.round(sourceEvents.length * ((index + 1) / options.frames)));
    const state = cursor === 0 ? initialState() : replay(sourceEvents.slice(0, cursor));
    const view = renderForTest(
      <DependenciesProvider execute={async () => undefined}>
        <App
          state={state}
          events={sourceEvents.slice(Math.max(0, cursor - 200), cursor)}
          mode={options.replayFile ? 'replay' : 'live'}
          cursor={cursor}
          total={sourceEvents.length}
          playing={false}
          speed={options.speed}
          replayAvailable={options.replayFile !== undefined}
          url={options.url}
          focusCmd={options.focusCmd}
          width={dimensions.width}
          height={dimensions.height}
        />
      </DependenciesProvider>,
    );
    const frame = plainText(view.lastFrame() ?? '');
    view.unmount();
    return frame;
  });
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  stdout: OutputStream = process.stdout,
): Promise<number> {
  const options = parseCliArgs(argv, env);
  if (options.noTty || !stdout.isTTY) {
    const frames = renderHeadlessFrames(options, {
      width: stdout.columns ?? 100,
      height: stdout.rows ?? 30,
    });
    stdout.write(`${frames.join('\n')}\n`);
    return 0;
  }

  const app = renderInk(
    <DependenciesProvider>
      <RelayGraphApp
        url={options.url}
        replayFile={options.replayFile}
        speed={options.speed}
        focusCmd={options.focusCmd}
        startInReplay={options.replayFile !== undefined}
      />
    </DependenciesProvider>,
    { stdout: stdout as NodeJS.WriteStream },
  );
  await app.waitUntilExit();
  return 0;
}

const invokedPath = process.argv[1];
const isMain = invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url;
if (isMain) {
  void runCli().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
