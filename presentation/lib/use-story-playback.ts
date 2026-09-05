"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One finite, visible-page timeline. Every mount starts without a gesture. */
export function useStoryPlayback(durations: readonly number[]) {
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [hidden, setHidden] = useState(false);
  const clock = useRef(0);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => {
      setReduced(preference.matches);
      if (preference.matches) { clock.current = total; setElapsed(total); }
    };
    const visibility = () => setHidden(document.hidden);
    syncPreference();
    visibility();
    preference.addEventListener("change", syncPreference);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      preference.removeEventListener("change", syncPreference);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [total]);

  useEffect(() => {
    if (paused || reduced || hidden || clock.current >= total) return;
    let previous = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      clock.current = Math.min(total, clock.current + now - previous);
      previous = now;
      setElapsed(clock.current);
      if (clock.current < total) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, reduced, hidden, total, elapsed === 0]);

  let cutoff = 0;
  let beat = durations.length - 1;
  for (let i = 0; i < durations.length; i++) {
    cutoff += durations[i];
    if (elapsed < cutoff) { beat = i; break; }
  }
  const replay = useCallback(() => { clock.current = reduced ? total : 0; setElapsed(clock.current); setPaused(false); }, [reduced, total]);
  const complete = elapsed >= total;
  return { beat, elapsed, progress: elapsed / total, paused, reduced, hidden, complete, playing: !paused && !reduced && !hidden && !complete, toggle: () => setPaused(value => !value), replay };
}
