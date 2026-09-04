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

  it('marks a worktree dim until its handoff is accepted', () => {
    const frontend = midClarificationState.tasks['t-frontend-login']!;
    const backend = midClarificationState.tasks['t-backend-auth']!;

    expect(taskDetail(frontend)).toMatchObject({ dim: true });
    expect(taskDetail(backend)).toMatchObject({ dim: false });
  });
});
