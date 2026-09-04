import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { objectGraph } from '../__fixtures__/graph.js';
import { Inbox } from './Inbox.js';

describe('inbox panel', () => {
  it('windows rows so an off-screen selected inbox object stays visible', () => {
    const extras = Array.from({ length: 5 }, (_, index) => ({
      ...objectGraph.inbox[0]!,
      id: `inbox-extra-${index}`,
      title: `extra inbox ${index}`,
    }));
    const items = [...objectGraph.inbox, ...extras];
    const { lastFrame } = render(
      <Inbox items={items} height={4} selected={{ kind: 'inbox', id: 'inbox-extra-4' }} />,
    );

    expect(lastFrame()).toContain('extra inbox 4');
  });
});
