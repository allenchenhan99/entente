# Task: add secure login to this application

Implement passwordless login on the existing Hono app (`src/app.ts`), reusing `UserRepo` (`src/models/user.ts`),
`SessionStore` (`src/session/store.ts`) and `EmailSender` / `MemoryEmailSender` (`src/email/stub.ts`).

Required behaviour:

1. `POST /auth/request` with JSON `{ "email": string }` sends the user a login credential by email and responds
   `202 { "ok": true }`. Unknown emails get the identical 202 and no email is sent (no account enumeration).
2. `POST /auth/verify` completes the login. Its JSON body depends on the login mechanism (see below). On success
   it responds `200` with the user (`{ "id", "email", "name" }`) and sets an `HttpOnly; SameSite=Lax` cookie named
   `session` whose value is a `SessionStore` session id with a 24 h TTL. Invalid, expired or already-used
   credentials respond `401 { "error": "invalid or expired login" }`.
3. `GET /me` returns `200` with the user for a valid `session` cookie, else the existing `401`.
4. The login credential expires after 15 minutes and is single-use. Store only a SHA-256 hash of it.
5. `createApp` must accept an options object: `createApp({ users?: UserRepo, emails?: EmailSender, now?: () => number })`
   (defaults: seeded `UserRepo`, a `MemoryEmailSender`, `Date.now`). The old positional form `createApp(users)` must keep working.
6. Emails are sent through the `EmailSender`; tests read them back from `MemoryEmailSender.sent`.

**The login mechanism has not been decided by the product owner** (see the conversation history): either
(a) a magic link — the email contains a URL with a `token` query parameter and `POST /auth/verify` takes `{ "token" }`,
or (b) a 6-digit one-time code — the email text contains the code and `POST /auth/verify` takes `{ "email", "code" }`.
Exactly one must be implemented and it must match the product owner's decision.

Allowed paths: `src/auth/**`, `src/app.ts`, `tests/auth/**`. Do not modify anything else. Run `npm run typecheck`
and `npx vitest run` before finishing.
