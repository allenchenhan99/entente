import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initialState } from '@relay/protocol';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { postReview } from '../commands.js';
import { resolveSessionToken, withSessionToken } from './auth.js';
import { useLiveState, type FetchLike } from './live.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

describe('session token resolution', () => {
  it('prefers the flag, then RELAY_TOKEN, then <repo>/.relay/session.token, else undefined', () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, '.relay'));
    fs.writeFileSync(path.join(repo, '.relay', 'session.token'), 'filetoken\n');
    expect(resolveSessionToken({ flag: 'flag', env: { RELAY_TOKEN: 'env' }, cwd: repo })).toBe('flag');
    expect(resolveSessionToken({ env: { RELAY_TOKEN: 'env' }, cwd: repo })).toBe('env');
    expect(resolveSessionToken({ env: {}, cwd: repo })).toBe('filetoken');
    expect(resolveSessionToken({ env: { RELAY_REPO: repo }, cwd: tmpDir() })).toBe('filetoken');
    expect(resolveSessionToken({ env: { RELAY_DIR: path.join(repo, '.relay') }, cwd: tmpDir() })).toBe('filetoken');
    expect(resolveSessionToken({ env: {}, cwd: tmpDir() })).toBeUndefined();
  });
});

describe('live client sends the session token', () => {
  it('adds Authorization: Bearer on /state, /events/log and /events while keeping the accept header', async () => {
    const events = [{ seq: 1, ts: '2026-09-05T10:00:00+08:00', mission_id: 'm-1', actor: 'relayd', type: 'mission_failed', payload: { reason: 'x' } }];
    // An SSE response whose body stays open, so the client reports `connected` and keeps listening.
    const openStream = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const raw = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...initialState(), last_seq: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(events), { status: 200 }))
      .mockResolvedValueOnce(openStream);
    const fetcher = withSessionToken(raw, 'tok');

    function Probe() {
      const live = useLiveState('http://relay.test', { fetch: fetcher, reconnectDelayMs: 0 });
      return <Text>{`connected=${live.connected} events=${live.events.length}`}</Text>;
    }
    const view = render(<Probe />);
    await waitFor(() => (view.lastFrame() ?? '').includes('connected=true events=1'));

    const calls = raw.mock.calls.map(([url, init]) => [url, Object.fromEntries(new Headers(init?.headers).entries())]);
    expect(calls).toEqual([
      ['http://relay.test/state', { authorization: 'Bearer tok' }],
      ['http://relay.test/events/log?since=0', { authorization: 'Bearer tok' }],
      ['http://relay.test/events?since=1', { authorization: 'Bearer tok', accept: 'text/event-stream' }],
    ]);
    view.unmount();
  });

  it('commands carry the token next to the JSON content type', async () => {
    const raw = vi.fn<FetchLike>().mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await postReview({ fetch: withSessionToken(raw, 'tok'), url: 'http://relay.test', taskId: 't-1', criterionId: 'AC-1', status: 'passed' });
    const [url, init] = raw.mock.calls[0]!;
    expect(url).toBe('http://relay.test/tasks/t-1/review');
    expect(init?.method).toBe('POST');
    expect(Object.fromEntries(new Headers(init?.headers).entries())).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
  });

  it('without a token the wrapper is a no-op', async () => {
    const raw = vi.fn<FetchLike>().mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await withSessionToken(raw, undefined)('http://relay.test/state');
    expect(raw.mock.calls[0]?.[1]).toBeUndefined();
  });
});
