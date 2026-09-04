import { ClarifyBody, ReviewBody } from '@relay/protocol';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { objectGraph, objectGraphApi } from './__fixtures__/graph.js';
import { midClarificationState } from './__fixtures__/states.js';
import { DependenciesProvider, type FetchLike } from './context.js';
import { useAppKeys } from './keys.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const api = objectGraphApi();

function Harness({ selectedRef }: { selectedRef: { kind: 'node' | 'edge' | 'inbox'; id: string } }) {
  const keys = useAppKeys({
    state: midClarificationState,
    graph: objectGraph,
    selectedRef,
    actions: api.actionsFor(selectedRef, objectGraph, midClarificationState),
    region: selectedRef.kind === 'inbox' ? 'inbox' : 'graph',
    url: 'http://relay.test/',
    focusCmd: 'none',
    replayAvailable: false,
  });
  return <Text>{`open=${keys.overlayOpen} tab=${keys.overlayTab} mode=${keys.inputMode ?? '-'} value=${keys.inputValue}`}</Text>;
}

describe('actions', () => {
  it('opens Questions with a and posts task clarification from the action target', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const view = render(
      <DependenciesProvider fetch={fakeFetch} execute={vi.fn()} graphApi={api}>
        <Harness selectedRef={{ kind: 'edge', id: 'edge-backend-contract' }} />
      </DependenciesProvider>,
    );

    view.stdin.write('a');
    await flush();
    expect(view.lastFrame()).toContain('open=true tab=Questions mode=answer');
    view.stdin.write('Use magic links');
    view.stdin.write('\r');
    await flush();

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('http://relay.test/tasks/t-backend-auth/clarify');
    expect(ClarifyBody.parse(JSON.parse(String(init?.body)))).toEqual({
      answers: [{ question_id: 'Q1', answer: 'Use magic links' }],
    });
  });

  it('uses action.target.criterion_id for pass and fail reviews', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const renderHarness = () => render(
      <DependenciesProvider fetch={fakeFetch} execute={vi.fn()} graphApi={api}>
        <Harness selectedRef={{ kind: 'edge', id: 'edge-backend-evidence' }} />
      </DependenciesProvider>,
    );

    const pass = renderHarness();
    pass.stdin.write('p');
    await flush();
    expect(ReviewBody.parse(JSON.parse(String(fakeFetch.mock.calls[0]![1]?.body)))).toEqual({
      criterion_id: 'AC-2',
      status: 'passed',
    });
    pass.unmount();

    const fail = renderHarness();
    fail.stdin.write('f');
    await flush();
    expect(fail.lastFrame()).toContain('mode=review-failure');
    fail.stdin.write('Button misses focus ring');
    fail.stdin.write('\r');
    await flush();
    const [url, init] = fakeFetch.mock.calls[1]!;
    expect(url).toBe('http://relay.test/tasks/t-backend-auth/review');
    expect(ReviewBody.parse(JSON.parse(String(init?.body)))).toEqual({
      criterion_id: 'AC-2',
      status: 'failed',
      observed_failure: 'Button misses focus ring',
    });
  });

  it('keeps cancel confirmation before posting to the action target', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const view = render(
      <DependenciesProvider fetch={fakeFetch} execute={vi.fn()} graphApi={api}>
        <Harness selectedRef={{ kind: 'node', id: 't-backend-auth' }} />
      </DependenciesProvider>,
    );

    view.stdin.write('x');
    await flush();
    expect(view.lastFrame()).toContain('mode=cancel-confirm');
    expect(fakeFetch).not.toHaveBeenCalled();
    view.stdin.write('y');
    await flush();
    expect(fakeFetch.mock.calls[0]?.[0]).toBe('http://relay.test/tasks/t-backend-auth/cancel');
  });
});
