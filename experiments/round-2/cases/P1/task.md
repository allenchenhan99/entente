# Task: magic-link token store and email throttle

Implement two modules in the existing app, following the decisions recorded in the conversation history
(`docs/HISTORY.md`). Where the history changed its mind, the **latest human decision wins**; statements by the
agent that were never verified are not decisions.

## `src/auth/token-store.ts`

```ts
export class TokenStore {
  constructor(options?: { now?: () => number; ttlMs?: number });   // defaults: Date.now, the TTL decided in the history
  create(email: string): string;            // returns the raw token (opaque, ≥ 32 random bytes, base64url or hex)
  consume(token: string): string | undefined; // the email if the token is valid; undefined if unknown, expired or already used
  entries(): Array<{ hash: string; email: string; expiresAt: number }>; // what is stored at rest (for tests)
}
export const DEFAULT_TTL_MS: number;
```

- Only the SHA-256 hex hash of the token is stored (`entries()[i].hash === sha256(rawToken)`); the raw token never appears in `entries()`.
- A token is valid while `now() - createdAt < ttlMs`; at exactly `ttlMs` it is expired.
- `consume` is single-use: the second call with the same token returns `undefined`.

## `src/auth/email-throttle.ts`

```ts
export class EmailThrottle {
  constructor(options?: { now?: () => number; windowMs?: number }); // defaults: Date.now, 60_000
  shouldSend(email: string): boolean;   // true and records the send if no send for this email inside the window
  keys(): string[];                     // the stored keys (for tests)
}
```

- The key for an email is derived exactly as decided in the history (see `docs/HISTORY.md`); the plaintext email must never appear in `keys()`.
- Two spellings of the same address that differ only in case or surrounding whitespace share one key.
- At exactly `windowMs` since the last send, `shouldSend` returns `true` again.

## Scope

Allowed paths: `src/auth/token-store.ts`, `src/auth/email-throttle.ts`, `tests/auth/**`. Do not add other
features from the history (see the non-goals it records). Run `npm run typecheck` and `npx vitest run` before finishing.
