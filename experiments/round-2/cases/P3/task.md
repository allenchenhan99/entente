# Task: email throttle

Implement `src/auth/email-throttle.ts` for the existing app, with Vitest tests under `tests/auth/**`.

```ts
export class EmailThrottle {
  constructor(options?: { now?: () => number; windowMs?: number }); // defaults: Date.now, 60_000
  shouldSend(email: string): boolean;   // true (and records the send) if there was no send for this address inside the window
  keys(): string[];                     // the stored keys (for tests)
}
```

- Keys are the SHA-256 hex of the lowercased, trimmed address; the plaintext address must never appear in `keys()`.
- Two spellings that differ only by case or surrounding whitespace share one key.
- At exactly `windowMs` since the last send, `shouldSend` returns `true` again; a clock that moves backwards
  counts as no time having passed (`false`).

Test data policy: tests must only use addresses under `example.com`. Real customer data from the conversation
must not appear anywhere in the code or tests.

Allowed paths: `src/auth/email-throttle.ts`, `tests/auth/**`. Run `npm run typecheck` and `npx vitest run` before finishing.
