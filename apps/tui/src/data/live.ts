import {
  Event as EventSchema,
  State as StateSchema,
  initialState,
  reduce,
  routes,
  type Event,
  type State,
} from '@relay/protocol';
import { useEffect, useState } from 'react';

import { consumeSse } from './sse.js';

const EVENT_RING_SIZE = 200;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LiveOptions {
  fetch?: FetchLike;
  reconnectDelayMs?: number;
}

export interface LiveView {
  state: State;
  events: Event[];
  connected: boolean;
  error?: Error;
}

function endpoint(baseUrl: string, route: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${route}`;
}

function responseError(method: string, url: string, response: Response): Error {
  return new Error(`${method} ${url} failed: ${response.status} ${response.statusText}`.trim());
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || milliseconds <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function useLiveState(url: string, options: LiveOptions = {}): LiveView {
  const fetcher = options.fetch ?? globalThis.fetch;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  const [state, setState] = useState<State>(initialState);
  const [events, setEvents] = useState<Event[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error>();

  useEffect(() => {
    const abort = new AbortController();
    let active = true;

    const run = async () => {
      let lastSeq = 0;
      while (active && !abort.signal.aborted) {
        try {
          const stateUrl = endpoint(url, routes.state);
          const response = await fetcher(stateUrl, { signal: abort.signal });
          if (!response.ok) throw responseError('GET', stateUrl, response);
          const snapshot = StateSchema.parse(await response.json());
          lastSeq = snapshot.last_seq;
          if (!active) return;
          setState(snapshot);
          setError(undefined);
          break;
        } catch (cause) {
          if (!active || abort.signal.aborted) return;
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          await delay(reconnectDelayMs, abort.signal);
        }
      }

      while (active && !abort.signal.aborted) {
        const eventsUrl = `${endpoint(url, routes.events)}?since=${lastSeq}`;
        try {
          const response = await fetcher(eventsUrl, {
            signal: abort.signal,
            headers: { accept: 'text/event-stream' },
          });
          if (!response.ok) throw responseError('GET', eventsUrl, response);
          if (!active) return;
          setConnected(true);
          setError(undefined);
          await consumeSse(response, (message) => {
            const event = EventSchema.parse(JSON.parse(message.data));
            if (event.seq <= lastSeq) return;
            lastSeq = event.seq;
            setState((current) => reduce(current, event));
            setEvents((current) => [...current, event].slice(-EVENT_RING_SIZE));
          });
        } catch (cause) {
          if (!active || abort.signal.aborted) return;
          setError(cause instanceof Error ? cause : new Error(String(cause)));
        } finally {
          if (active) setConnected(false);
        }
        await delay(reconnectDelayMs, abort.signal);
      }
    };

    void run();
    return () => {
      active = false;
      abort.abort();
    };
  }, [fetcher, reconnectDelayMs, url]);

  return { state, events, connected, error };
}
