// Oracle for T5. Never given to the child; copied in at verification time.
// Asserts F3 (unknown and known addresses are indistinguishable: same 202, same body).
import { describe, expect, it } from 'vitest';
import { respondToLinkRequest } from '../src/auth/enumeration.js';

describe('T5 enumeration guard', () => {
  it('F3: a known address gets 202', () => {
    expect(respondToLinkRequest(true).status).toBe(202);
  });

  it('F3: an unknown address gets 202 as well, not 404 or 400', () => {
    expect(respondToLinkRequest(false).status).toBe(202);
  });

  it('F3: the two responses are byte-identical', () => {
    expect(JSON.stringify(respondToLinkRequest(false)))
      .toBe(JSON.stringify(respondToLinkRequest(true)));
  });

  it('F3: the body says nothing about whether the account exists', () => {
    const text = JSON.stringify(respondToLinkRequest(false)).toLowerCase();
    for (const leak of ['not found', 'unknown', 'no account', 'does not exist', 'invalid email']) {
      expect(text).not.toContain(leak);
    }
  });
});
