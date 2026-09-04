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

describe('real agent screens', () => {
  const now = 10_000;
  const base = { now, lastOutputAt: now - QUIET_MS - 1, exited: false };

  it('Claude Code idle: the ❯ composer sits above the permissions status bar', () => {
    const lines = [
      ' ▐▛███▛█   Claude Code v2.1.260',
      '▝▜██████▀  Fable 5.1 with high effort · Claude Max',
      '  ▝▝ ▝▝    ~/entente-demo/app/.relay/wt/t-backend-auth',
      '⚠ 1 MCP server needs authentication · run /mcp',
      '────────────────────────────────────────────────────────────',
      '❯',
      '────────────────────────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 7 agents                                   /rc',
    ];
    const r = evaluateReadiness({ paneId: 'relay:1', lines, ...base });
    expect(r.ready).toBe(true);
    expect(r.detail).toContain('❯');
  });

  it('Codex idle: the › composer sits above the model/cwd footer', () => {
    const lines = [
      '│ >_ OpenAI Codex (v0.153.2)                               │',
      '╰──────────────────────────────────────────────────────────╯',
      '• You have 2 usage limit resets available. Run /usage to use one.',
      '› Ask Codex to do anything',
      '  gpt-5.6-sol default · ~/entente-demo/app/.relay/wt/t-frontend-login',
    ];
    const r = evaluateReadiness({ paneId: 'relay:2', lines, ...base });
    expect(r.ready).toBe(true);
  });

  it('Claude Code working: the busy line wins even when a composer is drawn', () => {
    const lines = ['⏺ Calling relay, running 1 shell command…', '✶ Discombobulating… (2m 14s · ↓ 11.3k tokens)', '     interrupting Claude\'s current work — esc to interrupt', '❯', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'];
    expect(evaluateReadiness({ paneId: 'relay:1', lines, ...base }).ready).toBe(false);
  });
});
