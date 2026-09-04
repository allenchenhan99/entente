/** Tiny in-process wake-up bus for long-polling tools (`await_contract`, `await_verdict`). */

export type WaitOutcome = 'notified' | 'timeout' | 'aborted';

export class Waiters {
  private listeners = new Map<string, Set<() => void>>();

  notify(key: string): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const l of [...set]) l();
  }

  /** Resolves on the next `notify(key)`, on timeout, or when `signal` aborts. */
  wait(key: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve('aborted');
      let set = this.listeners.get(key);
      if (!set) this.listeners.set(key, (set = new Set()));
      const done = (outcome: WaitOutcome) => {
        clearTimeout(timer);
        set!.delete(listener);
        if (set!.size === 0) this.listeners.delete(key);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const listener = () => done('notified');
      const onAbort = () => done('aborted');
      const timer = setTimeout(() => done('timeout'), Math.max(0, timeoutMs));
      set.add(listener);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
