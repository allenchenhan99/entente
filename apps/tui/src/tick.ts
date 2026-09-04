import { useEffect, useState } from 'react';

export const ANIMATION_INTERVAL_MS = 120;

export function useAnimationTick(enabled = true): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setTick((current) => current + 1), ANIMATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return tick;
}
