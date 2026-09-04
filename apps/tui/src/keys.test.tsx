import { ClarifyBody, ReviewBody } from '@relay/protocol';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { midClarificationState } from './__fixtures__/states.js';
import { DependenciesProvider, type FetchLike } from './context.js';
import { useAppKeys } from './keys.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function Harness({ selectedTaskId = 't-frontend-login', region = 'tree' as const }) {
  const keys = useAppKeys({
    state: midClarificationState,
    selectedTaskId,
    region,
    url: 'http://relay.test/',
    focusCmd: 'herdr',
    replayAvailable: true,
  });
  return <Text>{`open=${keys.overlayOpen} tab=${keys.overlayTab} mode=${keys.inputMode ?? '-'} value=${keys.inputValue}`}</Text>;
}

describe('keys', () => {
  it('opens Questions with a and posts a schema-valid clarification answer', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const view = render(
      <DependenciesProvider fetch={fakeFetch} execute={vi.fn()}>
        <Harness />
      </DependenciesProvider>,
    );

    view.stdin.write('a');
    await flush();
    expect(view.lastFrame()).toContain('open=true tab=Questions mode=answer');
    view.stdin.write('Use magic links');
    view.stdin.write('\r');
    await flush();

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('http://relay.test/tasks/t-frontend-login/clarify');
    expect(init?.method).toBe('POST');
    expect(ClarifyBody.parse(JSON.parse(String(init?.body)))).toEqual({
      answers: [{ question_id: 'Q1', answer: 'Use magic links' }],
    });
  });

  it('collects observed failure after f and posts a schema-valid failed review', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const view = render(
      <DependenciesProvider fetch={fakeFetch} execute={vi.fn()}>
        <Harness />
      </DependenciesProvider>,
    );

    view.stdin.write('f');
    await flush();
    expect(view.lastFrame()).toContain('open=true tab=Evidence mode=review-failure');
    view.stdin.write('Button misses focus ring');
    view.stdin.write('\r');
    await flush();

    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('http://relay.test/tasks/t-frontend-login/review');
    expect(ReviewBody.parse(JSON.parse(String(init?.body)))).toEqual({
      criterion_id: 'AC-2',
      status: 'failed',
      observed_failure: 'Button misses focus ring',
    });
  });

  it('focuses an existing agent with argv and confirms cancellation before posting', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('{}', { status: 200 }));
    const execute = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <DependenciesProvider fetch={fakeFetch} execute={execute}>
        <Harness selectedTaskId="t-backend-auth" />
      </DependenciesProvider>,
    );

    view.stdin.write('\r');
    await flush();
    expect(execute).toHaveBeenCalledWith(['herdr', 'agent', 'focus', '%2']);

    view.stdin.write('x');
    await flush();
    expect(view.lastFrame()).toContain('mode=cancel-confirm');
    expect(fakeFetch).not.toHaveBeenCalled();
    view.stdin.write('y');
    await flush();
    expect(fakeFetch.mock.calls[0]?.[0]).toBe('http://relay.test/tasks/t-backend-auth/cancel');
  });
});
