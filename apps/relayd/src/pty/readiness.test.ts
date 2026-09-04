import { describe, it, expect } from 'vitest';
import { evaluateReadiness, QUIET_MS } from './readiness.js';

const now = 10_000;
const base = { paneId: 'relay:1', now, quietMs: QUIET_MS, exited: false };

describe('readiness (screen tier)', () => {
  it('is ready when the last non-empty line is an idle shell prompt', () => {
    for (const prompt of ['$ ', '$', '% ', '# ', '❯ ', '> ', '› ']) {
      const r = evaluateReadiness({ ...base, lines: ['a', 'b', prompt, ''], lastOutputAt: now - 1000 });
      expect(r.ready, prompt).toBe(true);
      expect(r.source).toBe('screen');
    }
  });

  it('is ready on Claude / Codex composer lines and on a trailing question', () => {
    expect(evaluateReadiness({ ...base, lines: ['> Try "fix the bug"', ''], lastOutputAt: now - 1000 }).ready).toBe(true);
    expect(evaluateReadiness({ ...base, lines: ['› Ask Codex', ''], lastOutputAt: now - 1000 }).ready).toBe(true);
    expect(evaluateReadiness({ ...base, lines: ['Do you want to proceed?', ''], lastOutputAt: now - 1000 }).ready).toBe(true);
  });

  it('is not ready while output is still flowing (quiet window not elapsed)', () => {
    const r = evaluateReadiness({ ...base, lines: ['$ '], lastOutputAt: now - 100 });
    expect(r.ready).toBe(false);
    expect(r.detail).toMatch(/output/i);
  });

  it('is not ready while the last line says the agent is working', () => {
    for (const line of ['esc to interrupt', 'Working…', 'Thinking (3s)', 'Running tests']) {
      expect(evaluateReadiness({ ...base, lines: [line], lastOutputAt: now - 1000 }).ready, line).toBe(false);
    }
  });

  it('is not ready on an ordinary line and reports unknown after exit', () => {
    expect(evaluateReadiness({ ...base, lines: ['compiling'], lastOutputAt: now - 1000 }).ready).toBe(false);
    const gone = evaluateReadiness({ ...base, exited: true, lines: ['$ '], lastOutputAt: now - 1000 });
    expect(gone).toMatchObject({ ready: false, source: 'unknown' });
    expect(evaluateReadiness({ ...base, lines: [], lastOutputAt: now - 1000 }).ready).toBe(false);
  });
});
