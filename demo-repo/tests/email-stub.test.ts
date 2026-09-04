import { describe, expect, it } from 'vitest';

import { MemoryEmailSender } from '../src/email/stub.js';

describe('MemoryEmailSender', () => {
  it('records messages in delivery order', async () => {
    const sender = new MemoryEmailSender();

    await sender.send({ to: 'ada@example.com', subject: 'First', text: 'Hello Ada' });
    await sender.send({ to: 'grace@example.com', subject: 'Second', text: 'Hello Grace' });

    expect(sender.sent).toEqual([
      { to: 'ada@example.com', subject: 'First', text: 'Hello Ada' },
      { to: 'grace@example.com', subject: 'Second', text: 'Hello Grace' },
    ]);
  });

  it('does not expose mutable recorded messages', async () => {
    const sender = new MemoryEmailSender();
    await sender.send({ to: 'ada@example.com', subject: 'Original', text: 'Hello' });

    const snapshot = sender.sent;
    snapshot[0].subject = 'Changed';

    expect(sender.sent[0].subject).toBe('Original');
  });
});
