import { describe, it, expect } from 'vitest';
import { createPaneAnnotations } from './annotations.js';

const pane = (pane_id: string, extra: Record<string, unknown> = {}) => ({
  pane_id, role: 'shell', cwd: '/repo', alive: true, cols: 80, rows: 24, started_at: 't', ...extra,
});

describe('pane annotations', () => {
  it('leaves a pane relayd knows nothing about exactly as the host reported it', () => {
    const annotations = createPaneAnnotations();
    const info = pane('relay:1');
    expect(annotations.apply(info)).toBe(info);
  });

  it('turns the shell the human ran an agent in into that agent', () => {
    const annotations = createPaneAnnotations();
    annotations.set('relay:1', { role: 'brain', runtime: 'claude-code' });

    const [first, second] = annotations.applyAll([pane('relay:1'), pane('relay:2')]);

    // A runtime is what puts a node on the network, and the host will never report one here: it
    // spawned a shell and, as far as it can tell, a shell is still what is running.
    expect(first).toMatchObject({ pane_id: 'relay:1', role: 'brain', runtime: 'claude-code' });
    expect(first.cwd).toBe('/repo');
    expect(second).toMatchObject({ pane_id: 'relay:2', role: 'shell' });
    expect(second).not.toHaveProperty('runtime');
  });

  it('merges rather than replaces, so two facts about one pane both survive', () => {
    const annotations = createPaneAnnotations();
    annotations.set('relay:1', { runtime: 'codex' });
    annotations.set('relay:1', { role: 'brain' });

    expect(annotations.get('relay:1')).toEqual({ runtime: 'codex', role: 'brain' });
  });

  it('forgets a pane on request, so a closed one does not haunt the next listing', () => {
    const annotations = createPaneAnnotations();
    annotations.set('relay:1', { role: 'brain', runtime: 'codex' });
    annotations.clear('relay:1');

    expect(annotations.apply(pane('relay:1'))).toMatchObject({ role: 'shell' });
  });
});
