import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';

import { midClarificationState } from '../__fixtures__/states.js';
import { Tree, taskDetail } from './Tree.js';

describe('tree', () => {
  it('renders mission status, lint totals, and all three state layers for each task', () => {
    const { lastFrame } = render(<Tree state={midClarificationState} height={14} selectedTaskId="t-backend-auth" />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('MISSION  Add secure login to this application  executing');
    expect(frame).toContain('lint: 0 errors · 0 warnings');
    expect(frame).toContain('backend');
    expect(frame).toContain('● working  executing  accepted  v2');
    expect(frame).toContain('frontend');
    expect(frame).toContain('○ idle  proposed  needs_clarification  v1');
    expect(frame).toContain('e2e');
    expect(frame).toContain('◐ blocked  proposed  proposed  v1');
  });

  it('shows blocked dependencies, clarification count, and worktree paths', () => {
    const { lastFrame } = render(<Tree state={midClarificationState} height={14} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('◐ blocked on t-backend-auth');
    expect(frame).toContain('? 2');
    expect(frame).toContain('wt .relay/wt/t-backend-auth');
    expect(frame).toContain('wt .relay/wt/t-frontend-login');
  });

  it('shows open mission-level questions for the human on the mission line', () => {
    const missions = Object.fromEntries(Object.entries(midClarificationState.missions).map(([id, m]) => [id, { ...m, open_questions: [{ id: 'Q1', text: 'Which mechanism?', blocking: true }] }]));
    const { lastFrame } = render(<Tree state={{ ...midClarificationState, missions }} height={14} />);
    expect(lastFrame() ?? '').toContain('? 1 for you');
  });

  it('keeps every task on two lines when the worktree path is a long absolute path', () => {
    // Observed live at a 74-column pane: absolute worktree paths soft-wrapped, each task ate 3-4 rows
    // instead of 2, and the task rows were pushed out of the height-clipped box entirely.
    const deep = '/tmp/claude-1000/-home-user-code-Futuremode-entente/4a8a19b4-e83e/scratchpad/app';
    const state = structuredClone(midClarificationState);
    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (task.worktree) task.worktree.path = `${deep}/.relay/wt/${taskId}`;
    }

    const { lastFrame } = render(<Tree state={state} height={14} />);
    const lines = (lastFrame() ?? '').split('\n');

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines.some((l) => l.includes('backend') && l.includes('● working'))).toBe(true);
    expect(lines.some((l) => l.includes('frontend') && l.includes('○ idle'))).toBe(true);
    expect(lines.some((l) => l.includes('e2e') && l.includes('◐ blocked'))).toBe(true);
    expect(lastFrame()).toContain('.relay/wt/t-backend-auth');
    expect(lastFrame()).not.toContain('/tmp/claude-1000');
  });

  it('truncates a mission title that would overflow instead of wrapping it over the lint line', () => {
    const state = structuredClone(midClarificationState);
    Object.values(state.missions)[0]!.mission.title = 'Add secure login '.repeat(12).trim();

    const { lastFrame } = render(<Tree state={state} height={14} />);
    const lines = (lastFrame() ?? '').split('\n');

    expect(lines[0]).toMatch(/^MISSION {2}Add secure login/);
    expect(lines[1]).toBe('lint: 0 errors · 0 warnings');
  });

  it('marks a worktree dim until its handoff is accepted', () => {
    const frontend = midClarificationState.tasks['t-frontend-login']!;
    const backend = midClarificationState.tasks['t-backend-auth']!;

    expect(taskDetail(frontend)).toMatchObject({ dim: true });
    expect(taskDetail(backend)).toMatchObject({ dim: false });
  });
});
