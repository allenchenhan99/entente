import { initialState } from '@relay/protocol';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { useLiveState, type FetchLike } from './live.js';
import { SseParser } from './sse.js';

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for live state');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

function sseResponse(messages: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const midpoint = Math.floor(messages.length / 2);
      controller.enqueue(new TextEncoder().encode(messages.slice(0, midpoint)));
      controller.enqueue(new TextEncoder().encode(messages.slice(midpoint)));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('live SSE', () => {
  it('parses id and multiline data across chunks', () => {
    const parser = new SseParser();

    expect(parser.push('id: 7\r\ndata: {"hel')).toEqual([]);
    expect(parser.push('lo":\r\ndata: "world"}\r\n\r\n')).toEqual([
      { id: '7', data: '{"hello":\n"world"}' },
    ]);
  });

  it('gets the snapshot, reduces streamed events, caps the ring, and reconnects since last seq', async () => {
    const sourceEvents = Array.from({ length: 205 }, (_, index) => ({
      seq: index + 1,
      ts: `2026-09-05T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+08:00`,
      mission_id: 'm-001',
      actor: 'relayd',
      type: 'mission_failed',
      payload: { reason: `failure ${index + 1}` },
    }));
    const body = sourceEvents.map((event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    let keepOpen: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => { keepOpen = () => resolve(sseResponse('')); });
    const fakeFetch = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(JSON.stringify(initialState()), { status: 200 }))
      .mockResolvedValueOnce(sseResponse(body))
      .mockImplementationOnce(() => pending);

    function Probe() {
      const live = useLiveState('http://relay.test/', { fetch: fakeFetch, reconnectDelayMs: 0 });
      return <Text>{`${live.state.last_seq} events=${live.events.length} connected=${live.connected}`}</Text>;
    }
    const view = render(<Probe />);
    await waitFor(() => (view.lastFrame() ?? '').includes('205 events=200'));

    expect(fakeFetch.mock.calls[0]?.[0]).toBe('http://relay.test/state');
    expect(fakeFetch.mock.calls[1]?.[0]).toBe('http://relay.test/events?since=0');
    expect(fakeFetch.mock.calls[2]?.[0]).toBe('http://relay.test/events?since=205');
    expect(view.lastFrame()).toContain('205 events=200');

    view.unmount();
    keepOpen?.();
  });

  it('surfaces an initial HTTP error with context', async () => {
    const fakeFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('down', { status: 503 }));

    function Probe() {
      const live = useLiveState('http://relay.test', { fetch: fakeFetch, reconnectDelayMs: 10_000 });
      return <Text>{live.error?.message ?? 'ok'}</Text>;
    }
    const view = render(<Probe />);
    await waitFor(() => (view.lastFrame() ?? '').includes('503'));

    expect(view.lastFrame()).toContain('GET http://relay.test/state failed: 503');
    view.unmount();
  });
});
