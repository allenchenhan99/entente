import { ClarifyBody, ReplyBody } from '@relay/protocol';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { midClarificationState } from './__fixtures__/states.js';
import { objectGraphApi } from './__fixtures__/graph.js';
import { App } from './App.js';
import { DependenciesProvider, type FetchLike } from './context.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function renderObjects(options: {
  fetch?: FetchLike;
  initialSelectedRef?: { kind: 'node' | 'edge' | 'inbox'; id: string };
  replayAvailable?: boolean;
  onToggleSource?: () => void;
} = {}) {
  return render(
    <DependenciesProvider graphApi={objectGraphApi()} fetch={options.fetch} execute={vi.fn()}>
      <App
        state={midClarificationState}
        events={[]}
        mode="live"
        url="http://relay.test"
        focusCmd="none"
        width={100}
        height={41}
        initialSelectedRef={options.initialSelectedRef}
        replayAvailable={options.replayAvailable}
        onToggleSource={options.onToggleSource}
      />
    </DependenciesProvider>,
  );
}

describe('object selection', () => {
  it('selection cycles tree to graph to inbox to timeline and moves through graph objects', async () => {
    const view = renderObjects();
    expect(view.lastFrame()).toContain('▶ MISSION / WORKTREES');
    expect(view.lastFrame()).toContain('INBOX');

    view.stdin.write('\t');
    await flush();
    expect(view.lastFrame()).toContain('▶ HANDOFFS');
    view.stdin.write('j');
    await flush();
    expect(view.lastFrame()).toContain('\u001b[7m');
    expect(view.lastFrame()).toContain('t-backend-auth');

    view.stdin.write('\t');
    await flush();
    expect(view.lastFrame()).toContain('▶ INBOX');
    view.stdin.write('\t');
    await flush();
    expect(view.lastFrame()).toContain('▶ TIMELINE');
  });
});

describe('object actions', () => {
  it('lists only actionsFor keys and posts a schema-valid ReplyBody', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const view = renderObjects({ fetch: fakeFetch, initialSelectedRef: { kind: 'node', id: 't-backend-auth' } });

    expect(view.lastFrame()).toContain('r reply · x cancel');
    expect(view.lastFrame()).not.toContain('a answer');
    view.stdin.write('a');
    await flush();
    expect(fakeFetch).not.toHaveBeenCalled();

    view.stdin.write('r');
    await flush();
    view.stdin.write('Please retry after the schema merge');
    view.stdin.write('\r');
    await flush();

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('http://relay.test/tasks/t-backend-auth/reply');
    expect(ReplyBody.parse(JSON.parse(String(init?.body)))).toEqual({ message: 'Please retry after the schema merge' });
  });

  it('posts mission clarification to the action target mission', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const view = renderObjects({ fetch: fakeFetch, initialSelectedRef: { kind: 'node', id: 'planner' } });

    expect(view.lastFrame()).toContain('a answer');
    view.stdin.write('a');
    await flush();
    view.stdin.write('Use email magic links');
    view.stdin.write('\r');
    await flush();

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('http://relay.test/missions/m-001/clarify');
    expect(ClarifyBody.parse(JSON.parse(String(init?.body)))).toEqual({
      answers: [{ question_id: 'Q9', answer: 'Use email magic links' }],
    });
  });

  it('does not reuse an unavailable reply key as a global replay command', async () => {
    const toggle = vi.fn();
    const view = renderObjects({
      initialSelectedRef: { kind: 'node', id: 't-frontend-login' },
      replayAvailable: true,
      onToggleSource: toggle,
    });

    expect(view.lastFrame()).not.toContain('r reply');
    view.stdin.write('r');
    await flush();
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe('object story', () => {
  it.each([
    [{ kind: 'node', id: 't-backend-auth' } as const, 'Backend agent'],
    [{ kind: 'edge', id: 'edge-backend-contract' } as const, 'Backend contract'],
  ])('shows describe facts before storyFor lines for %s', async (ref, title) => {
    const view = renderObjects({ initialSelectedRef: ref });
    view.stdin.write('\r');
    await flush();
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain(`[Story]`);
    expect(frame).toContain(title);
    expect(frame).toContain(`id: ${ref.id}`);
    expect(frame.indexOf(`id: ${ref.id}`)).toBeLessThan(frame.indexOf(`Story begins for ${ref.id}.`));
  });
});

describe('object inbox', () => {
  it('renders kind icons and jumps to the item ref before opening Story', async () => {
    const view = renderObjects();
    const initial = view.lastFrame() ?? '';
    expect(initial).toContain('? backend asks one question');
    expect(initial).toContain('◐ backend is blocked');

    view.stdin.write('\t');
    await flush();
    view.stdin.write('\t');
    await flush();
    view.stdin.write('\r');
    await flush();

    expect(view.lastFrame()).toContain('Backend contract');
    expect(view.lastFrame()).toContain('[Story]');
  });
});
