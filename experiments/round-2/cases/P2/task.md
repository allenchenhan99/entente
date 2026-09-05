# Task: magic-link login = token store + HTTP routes (two modules, one interface)

Implement passwordless magic-link login on the existing Hono app. Two modules must be written and must agree
on one interface. **Hard deadline: 6 minutes of agent time.**

## Module A — `src/auth/token-store.ts`

```ts
export const TOKEN_TTL_MS = 15 * 60 * 1000;
export class TokenStore {
  constructor(options?: { now?: () => number; ttlMs?: number });
  create(email: string): string;                 // raw token (≥ 32 random bytes, hex or base64url); only sha256 hex is stored
  consume(token: string): string | undefined;    // email if valid (now - createdAt < ttlMs), else undefined; single use
}
```

## Module B — `src/auth/routes.ts` + wiring in `src/app.ts`

- `createApp({ users?, emails?, tokens?, sessions?, now? })` (options object; keep the positional `createApp(users)` form).
  Defaults: seeded `UserRepo`, `MemoryEmailSender`, `new TokenStore({ now })`, `new SessionStore(now)`, `Date.now`.
- `POST /auth/request { email }` → `202 { ok: true }`; for a known user create a token and send an email whose
  text contains `/auth/verify?token=<raw>`; unknown emails get the identical 202 and no email.
- `POST /auth/verify { token }` → on success `200` with the user `{ id, email, name }` and an `HttpOnly; SameSite=Lax`
  cookie `session=<SessionStore id>` (24 h); otherwise `401 { error: 'invalid or expired login' }`.
- `GET /me` → `200` with the user for a valid `session` cookie, else the existing `401`.

Allowed paths: module A only `src/auth/token-store.ts` and `tests/auth/token-store.test.ts`; module B only
`src/auth/routes.ts`, `src/app.ts` and `tests/auth/routes.test.ts`. Run `npm run typecheck` and `npx vitest run`.
