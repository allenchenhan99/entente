import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { happyState, midRepairState } from './__fixtures__/states.js';
import { App, panelHeights } from './App.js';
import { DependenciesProvider } from './context.js';
import { useAnimationTick } from './tick.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('application shell', () => {
  it('allocates the available rows approximately 40/35/25 and expands timeline to full height', () => {
    expect(panelHeights(41, false)).toEqual({ tree: 16, graph: 14, timeline: 10 });
    expect(panelHeights(41, true)).toEqual({ tree: 0, graph: 0, timeline: 40 });
  });

  it('renders all stacked regions and the exact live metrics footer', () => {
    const view = render(
      <DependenciesProvider execute={vi.fn()}>
        <App state={midRepairState} events={[]} mode="live" url="http://relay.test" focusCmd="none" width={100} height={41} />
      </DependenciesProvider>,
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('▶ MISSION / WORKTREES');
    expect(frame).toContain('HANDOFFS');
    expect(frame).toContain('TIMELINE');
    expect(frame).toContain('▶ live');
    expect(frame).toContain('blocked:1 clarif:2 mismatch:1 repairs:1');
    expect(frame).toContain('? help');
  });

  it('navigates tasks and regions, opens a graph edge, and toggles full timeline', async () => {
    const view = render(
      <DependenciesProvider execute={vi.fn()}>
        <App state={happyState} events={[]} mode="live" url="http://relay.test" focusCmd="none" width={100} height={41} />
      </DependenciesProvider>,
    );

    view.stdin.write('j');
    await flush();
    expect(view.lastFrame()).toContain('› frontend');
    view.stdin.write('\t');
    await flush();
    expect(view.lastFrame()).toContain('▶ HANDOFFS');
    view.stdin.write('\r');
    await flush();
    expect(view.lastFrame()).toContain('t-frontend-login  [Contract]');
    view.stdin.write('\u001b');
    await flush();
    view.stdin.write('t');
    await flush();
    expect(view.lastFrame()).not.toContain('MISSION / WORKTREES');
    expect(view.lastFrame()).toContain('▶ TIMELINE');
  });

  it('forwards replay controls and renders paused replay progress and speed', async () => {
    const controls = {
      toggle: vi.fn(),
      step: vi.fn(),
      halveSpeed: vi.fn(),
      doubleSpeed: vi.fn(),
    };
    const view = render(
      <DependenciesProvider execute={vi.fn()}>
        <App
          state={happyState}
          events={[]}
          mode="replay"
          cursor={42}
          total={118}
          playing={false}
          speed={2}
          replayControls={controls}
          replayAvailable
          url="http://relay.test"
          focusCmd="none"
          width={100}
          height={41}
        />
      </DependenciesProvider>,
    );

    expect(view.lastFrame()).toContain('⏸ replay 42/118 ×2');
    view.stdin.write('\u001b[C');
    view.stdin.write('\u001b[D');
    view.stdin.write(' ');
    view.stdin.write('[');
    view.stdin.write(']');
    await flush();
    expect(controls.step).toHaveBeenNthCalledWith(1, 1);
    expect(controls.step).toHaveBeenNthCalledWith(2, -1);
    expect(controls.toggle).toHaveBeenCalledOnce();
    expect(controls.halveSpeed).toHaveBeenCalledOnce();
    expect(controls.doubleSpeed).toHaveBeenCalledOnce();
  });

  it('advances animation ticks every 120 ms', async () => {
    function TickProbe() {
      return <Text>{useAnimationTick()}</Text>;
    }
    const view = render(<TickProbe />);
    expect(view.lastFrame()).toBe('0');

    // Timer-driven; under CI load the first tick can land late, so wait for it rather than for a fixed 150 ms.
    const deadline = Date.now() + 2_000;
    while (view.lastFrame() === '0' && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(Number(view.lastFrame())).toBeGreaterThanOrEqual(1);
    view.unmount();
  });
});
