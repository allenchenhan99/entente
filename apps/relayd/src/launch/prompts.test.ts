import { describe, it, expect } from 'vitest';
import { RECIPIENT_TOOLS, PLANNER_TOOLS } from '@relay/protocol';
import { bootstrapPrompt } from './index.js';
import type { LaunchSpec } from '../ports.js';

const base: LaunchSpec = {
  taskId: 't-frontend',
  token: 'tok',
  mcpUrl: 'http://127.0.0.1:7420/mcp',
  sessionId: 'sid',
  cwd: '/repo/.relay/wt/t-frontend',
  role: 'recipient',
  contractSummary: 'SUMMARY-MARKER goal: build the login form; allowed_paths: src/ui/**',
};

const MAX_BYTES = 6 * 1024;

describe('bootstrap prompt', () => {
  it('recipient prompt names every recipient tool, the needs_clarification flow, and stays under 6 KB', () => {
    const text = bootstrapPrompt(base);
    for (const tool of Object.values(RECIPIENT_TOOLS)) expect(text).toContain(tool);
    expect(text).toContain('needs_clarification');
    expect(text).toContain('accepted');
    expect(text).toContain('verification_plan');
    expect(text).toContain('failed_criteria');
    expect(text).toContain('allowed_paths');
    expect(text).toContain(base.cwd);
    expect(text).toContain(base.taskId);
    expect(text).toContain(base.contractSummary);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MAX_BYTES);
  });

  it('recipient prompt does not instruct planner tools', () => {
    const text = bootstrapPrompt(base);
    expect(text).not.toContain(PLANNER_TOOLS.propose_task);
  });

  it('planner prompt names every planner tool and the contract rules, and stays under 6 KB', () => {
    const text = bootstrapPrompt({ ...base, role: 'planner' });
    for (const tool of Object.values(PLANNER_TOOLS)) expect(text).toContain(tool);
    expect(text).toContain('npx vitest run');
    expect(text).toContain('max_repairs');
    expect(text).toContain('stagnation_limit');
    expect(text).toContain('lint_error');
    expect(text).toContain('60');
    expect(text).toContain(base.contractSummary);
    expect(text).not.toContain(RECIPIENT_TOOLS.submit_evidence);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MAX_BYTES);
  });

  it('truncates an oversized contract summary so the prompt stays under 6 KB', () => {
    const huge = 'x'.repeat(20_000);
    for (const role of ['recipient', 'planner'] as const) {
      const text = bootstrapPrompt({ ...base, role, contractSummary: huge });
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MAX_BYTES);
      expect(text).toContain('truncated');
    }
  });

  it('is deterministic', () => {
    expect(bootstrapPrompt(base)).toBe(bootstrapPrompt(base));
  });
});
