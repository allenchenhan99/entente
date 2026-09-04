import { type Event, type State, initialState, replay } from '@relay/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { loadJsonlFile } from './jsonl.js';

const MIN_SPEED = 0.125;
const MAX_SPEED = 16;
const EVENT_RING_SIZE = 200;

export interface ReplayView {
  state: State;
  events: Event[];
  cursor: number;
  total: number;
  playing: boolean;
  speed: number;
  toggle: () => void;
  step: (delta: 1 | -1) => void;
  seek: (cursor: number) => void;
  halveSpeed: () => void;
  doubleSpeed: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function timestampDelay(events: Event[], cursor: number, speed: number): number {
  if (cursor === 0) return 0;
  const previous = Date.parse(events[cursor - 1]?.ts ?? '');
  const next = Date.parse(events[cursor]?.ts ?? '');
  if (!Number.isFinite(previous) || !Number.isFinite(next)) return 0;
  return Math.max(0, next - previous) / speed;
}

export function useReplay(file: string, initialSpeed: number, autoPlay = true): ReplayView {
  const sourceEvents = useMemo(() => loadJsonlFile(file), [file]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [speed, setSpeed] = useState(clamp(initialSpeed, MIN_SPEED, MAX_SPEED));

  const seek = useCallback((nextCursor: number) => {
    setCursor(clamp(Math.floor(nextCursor), 0, sourceEvents.length));
  }, [sourceEvents.length]);
  const step = useCallback((delta: 1 | -1) => {
    setCursor((current) => clamp(current + delta, 0, sourceEvents.length));
  }, [sourceEvents.length]);
  const toggle = useCallback(() => setPlaying((current) => !current), []);
  const halveSpeed = useCallback(() => setSpeed((current) => clamp(current / 2, MIN_SPEED, MAX_SPEED)), []);
  const doubleSpeed = useCallback(() => setSpeed((current) => clamp(current * 2, MIN_SPEED, MAX_SPEED)), []);

  useEffect(() => {
    if (!playing) return undefined;
    if (cursor >= sourceEvents.length) {
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => setCursor((current) => Math.min(current + 1, sourceEvents.length)), timestampDelay(sourceEvents, cursor, speed));
    return () => clearTimeout(timer);
  }, [cursor, playing, sourceEvents, speed]);

  const state = useMemo(
    () => cursor === 0 ? initialState() : replay(sourceEvents.slice(0, cursor)),
    [cursor, sourceEvents],
  );
  const events = useMemo(
    () => sourceEvents.slice(Math.max(0, cursor - EVENT_RING_SIZE), cursor),
    [cursor, sourceEvents],
  );

  return {
    state,
    events,
    cursor,
    total: sourceEvents.length,
    playing,
    speed,
    toggle,
    step,
    seek,
    halveSpeed,
    doubleSpeed,
  };
}
