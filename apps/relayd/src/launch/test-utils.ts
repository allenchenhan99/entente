/** Test-only helpers: a fake executor that records every invocation and returns canned results. */
import type { Exec, ExecOptions, ExecResult } from './exec.js';

export interface RecordedCall { argv: string[]; opts?: ExecOptions }

export function fakeExec(handler: (argv: string[], opts?: ExecOptions) => Partial<ExecResult> | undefined = () => undefined) {
  const calls: RecordedCall[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, opts });
    const r = handler(argv, opts) ?? {};
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  };
  return { exec, calls };
}
