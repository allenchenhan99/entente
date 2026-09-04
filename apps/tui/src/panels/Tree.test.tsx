import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { objectGraph } from '../__fixtures__/graph.js';
import { midClarificationState } from '../__fixtures__/states.js';
import { Tree } from './Tree.js';

describe('tree objects', () => {
  it('renders mission state and only graph agent nodes with their three state layers', () => {
    const { lastFrame } = render(
      <Tree state={midClarificationState} graph={objectGraph} height={12} selected={{ kind: 'node', id: 't-backend-auth' }} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('MISSION  Add secure login to this application  executing');
    expect(frame).toContain('lint: 0 errors · 0 warnings');
    expect(frame).toContain('t-backend-auth  backend  ◐ blocked  executing  accepted  v2');
    expect(frame).toContain('t-frontend-login  frontend  ● working  executing  accepted  v1');
    expect(frame).not.toContain('planner  planner');
    expect(frame).not.toContain('verifier  verifier');
  });

  it('shows task worktree and clarification detail without wrapping rows', () => {
    const { lastFrame } = render(
      <Tree state={midClarificationState} graph={objectGraph} height={12} selected={{ kind: 'node', id: 't-backend-auth' }} />,
    );
    const lines = (lastFrame() ?? '').split('\n');

    expect(lines).toContain('    wt .relay/wt/t-backend-auth');
    expect(lines).toContain('    wt .relay/wt/t-frontend-login · ? 2');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('shows mission questions and highlights the selected object inverse', () => {
    const missions = Object.fromEntries(Object.entries(midClarificationState.missions).map(([id, mission]) => [id, {
      ...mission,
      open_questions: [{ id: 'Q9', text: 'Which auth method?', blocking: true }],
    }]));
    const { lastFrame } = render(
      <Tree state={{ ...midClarificationState, missions }} graph={objectGraph} height={12} selected={{ kind: 'node', id: 't-backend-auth' }} />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('? 1 for you');
    expect(frame).toContain('› t-backend-auth');
  });

  it('renders a sensible empty-agent placeholder', () => {
    const graph = { ...objectGraph, nodes: objectGraph.nodes.filter((node) => node.kind !== 'agent') };
    const { lastFrame } = render(<Tree state={midClarificationState} graph={graph} height={8} />);
    expect(lastFrame()).toContain('<no agents>');
  });

  it('windows agent rows so an off-screen selected object stays visible', () => {
    const extraAgents = Array.from({ length: 5 }, (_, index) => ({
      id: `t-extra-${index}`,
      kind: 'agent' as const,
      label: `extra-${index}`,
      column: 1 as const,
      status: 'pending' as const,
    }));
    const graph = { ...objectGraph, nodes: [...objectGraph.nodes, ...extraAgents] };
    const { lastFrame } = render(
      <Tree state={midClarificationState} graph={graph} height={8} selected={{ kind: 'node', id: 't-extra-4' }} />,
    );

    expect(lastFrame()).toContain('› t-extra-4');
  });
});
