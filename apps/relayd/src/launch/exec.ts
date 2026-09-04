/**
 * Command executor port. Every host/runtime takes `{ exec }` so tests can inject a fake that
 * records argv and returns canned output; production uses execa and never throws on non-zero exit.
 */
import { execa } from 'execa';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Exec = (argv: string[], opts?: ExecOptions) => Promise<ExecResult>;

export interface ExecDeps {
  exec?: Exec;
}

export const defaultExec: Exec = async (argv, opts = {}) => {
  const [file, ...args] = argv;
  if (!file) throw new Error('exec: argv must not be empty');
  const result = await execa(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    reject: false,
    stripFinalNewline: false,
  });
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    exitCode: result.exitCode ?? -1,
  };
};

/** Formats a failed command for error messages: `<argv> exited <code>: <stderr>`. */
export function describeFailure(argv: string[], result: ExecResult): string {
  const detail = (result.stderr || result.stdout).trim();
  return `\`${argv.join(' ')}\` exited ${result.exitCode}${detail ? `: ${detail}` : ''}`;
}
