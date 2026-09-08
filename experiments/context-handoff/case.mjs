/**
 * The benchmark case: standing facts, the tasks that depend on them, and the distractors.
 *
 * A plain module rather than YAML so the harness needs no parser and no dependency the
 * main project does not already have.
 *
 * `kind` is written here as the value relayd SHOULD derive from `source_refs` — it is not
 * a field an agent gets to assert (issue #7 §7). Arm C's extraction must reproduce these
 * kinds from the history alone; a mismatch is an extraction bug, and is scored as one.
 *
 * None of these facts are recoverable by reading demo-repo. That is the point:
 * demo-repo/README.md says "There is no login or auth of any kind".
 */

export const facts = [
  {
    id: 'F1',
    kind: 'human_confirmed',
    text: 'Magic-link tokens expire 15 minutes after issue and are single-use: consuming one must make a second consume fail, even inside the window.',
    source_refs: ['history:turn-31'],
    supersedes: ['F1-old'],
    related_paths: ['src/auth/token-store.ts'],
  },
  {
    id: 'F1-old',
    kind: 'human_confirmed',
    text: 'Magic-link tokens expire 30 minutes after issue.',
    source_refs: ['history:turn-12'],
    superseded_by: 'F1',
    note: 'Present in history and must NOT be carried forward. Shipping 30 minutes is a correctness failure, not a style difference.',
  },
  {
    id: 'F2',
    kind: 'human_confirmed',
    text: 'Rate limiting on link requests is 5 per hour keyed by EMAIL, never by IP.',
    source_refs: ['history:turn-44'],
    rationale: 'Two testers behind one office NAT locked each other out. Per-IP was tried and rejected.',
    related_paths: ['src/auth/rate-limit.ts'],
  },
  {
    id: 'F3',
    kind: 'human_confirmed',
    text: 'An unknown email gets exactly the same 202 and the same body as a known one. Never 404, never a different message.',
    source_refs: ['history:turn-19'],
    rationale: 'account-enumeration disclosure, raised as a compliance requirement',
    related_paths: ['src/auth/enumeration.ts'],
  },
  {
    id: 'F4',
    kind: 'check_verified',
    text: 'The session cookie is named `session`, HttpOnly, SameSite=Lax, Path=/, Max-Age 86400. Not `sid`, not SameSite=Strict.',
    source_refs: ['check:t-session-cookie:AC-1:attempt2'],
    related_paths: ['src/auth/session-cookie.ts'],
  },
  {
    id: 'F5',
    kind: 'human_confirmed',
    text: 'Audit entries never contain a magic-link token or its hash. Log the opaque tokenId only.',
    source_refs: ['history:turn-52'],
    rationale: 'legal review of log retention',
    related_paths: ['src/auth/audit.ts'],
  },
  {
    id: 'F6',
    kind: 'check_verified',
    text: 'Every timestamp written to the audit log is UTC ISO-8601 with a trailing Z, never a locale string and never epoch millis.',
    source_refs: ['check:t-audit:AC-2:attempt1'],
    related_paths: ['src/auth/audit.ts'],
  },
  {
    id: 'F7',
    kind: 'agent_reported',
    text: 'The email-send dedupe key is sha256 of the lowercased address, not the raw address, so the throttle map never holds plaintext addresses.',
    source_refs: ['history:turn-58'],
    note: 'Discovered by a sibling child, reported back, never independently checked. Tests whether a sibling finding propagates AND stays marked agent_reported rather than being promoted.',
    related_paths: ['src/auth/email-throttle.ts'],
  },
  {
    id: 'F8',
    kind: 'check_verified',
    text: 'Every time-dependent module takes an injectable now(): number and never calls Date.now() directly, matching the existing SessionStore.',
    source_refs: ['check:t-session-store:AC-3:attempt1', 'entry:src/session/store.ts'],
    note: 'Depended on by three tasks. This is what item reuse looks like.',
    related_paths: ['src/auth/token-store.ts', 'src/auth/rate-limit.ts', 'src/auth/email-throttle.ts'],
  },
];

/**
 * Also in the history, also emphatic, relevant to nothing in `tasks`. An extraction that
 * hands these to children is over-selecting, and the token cost shows up in arm C.
 */
export const distractors = [
  { id: 'D1', text: 'The web dashboard uses a 4px spacing grid and never inline styles.', source_refs: ['history:turn-8'] },
  { id: 'D2', text: 'Playwright screenshots are taken at 1280x1400 before any assertion.', source_refs: ['history:turn-23'] },
  { id: 'D3', text: 'The abandoned Redis session experiment is not to be revived.', source_refs: ['history:turn-37'] },
  { id: 'D4', text: 'Release notes are drafted on Mondays and never auto-published.', source_refs: ['history:turn-49'] },
];

/**
 * The split that makes the experiment fair:
 *   SHAPE  (signatures, file paths) lives in `goal` and is shown to every arm.
 *   POLICY (durations, keys, status codes) lives only in seed-history.md.
 * So a child never fails for guessing a method name — only for not knowing a decision.
 *
 * `requires` is the answer key: scoring only, never shown to a child, never given to
 * arm C's selector (which must judge relevance from the contract alone).
 *
 * `plausibleWrong` is what an uninformed child is expected to write. If arm A does NOT
 * produce these, the task is not context-dependent and must be replaced.
 */
export const tasks = [
  {
    id: 'T1',
    goal: 'Create src/auth/rate-limit.ts exporting `class RateLimiter`, constructed as `new RateLimiter(now: () => number)`, with one method `allow(key: string): boolean` that returns false once the allowance for that key is spent and true again as the window rolls forward.',
    allowedPaths: ['src/auth/rate-limit.ts'],
    requires: ['F2', 'F8'],
    plausibleWrong: 'keyed by IP; 10/min or 100/hour allowance; calls Date.now() directly',
    oracle: 'oracle/T1.rate-limit.test.ts',
  },
  {
    id: 'T2',
    goal: 'Create src/auth/audit.ts exporting `class AuditLog`, constructed as `new AuditLog(now: () => number)`, with `record(event: string, fields: Record<string, unknown>): void` and `entries(): Array<{ event: string; at: string; fields: Record<string, unknown> }>`.',
    allowedPaths: ['src/auth/audit.ts'],
    requires: ['F5', 'F6'],
    plausibleWrong: 'copies token/tokenHash into fields; `at` as epoch millis or a locale string',
    oracle: 'oracle/T2.audit.test.ts',
  },
  {
    id: 'T3',
    goal: 'Create src/auth/token-store.ts exporting `class TokenStore`, constructed as `new TokenStore(now: () => number)`, with `create(email: string): string` returning an opaque token and `consume(token: string): string | null` returning the email or null when the token is not usable.',
    allowedPaths: ['src/auth/token-store.ts'],
    requires: ['F1', 'F8'],
    plausibleWrong: '30- or 60-minute window; token reusable within the window; Date.now()',
    note: 'The superseded-fact case. History contains both 30 and 15 minutes.',
    oracle: 'oracle/T3.token-store.test.ts',
  },
  {
    id: 'T4',
    goal: 'Create src/auth/session-cookie.ts exporting `buildSessionCookie(id: string): string`, returning one Set-Cookie header value.',
    allowedPaths: ['src/auth/session-cookie.ts'],
    requires: ['F4'],
    plausibleWrong: 'cookie named sid; SameSite=Strict; missing HttpOnly; no Max-Age',
    oracle: 'oracle/T4.session-cookie.test.ts',
  },
  {
    id: 'T5',
    goal: 'Create src/auth/enumeration.ts exporting `respondToLinkRequest(known: boolean): { status: number; body: { message: string } }` for the POST /auth/request response.',
    allowedPaths: ['src/auth/enumeration.ts'],
    requires: ['F3'],
    plausibleWrong: '404 or 400 when unknown; different message text per branch',
    oracle: 'oracle/T5.enumeration.test.ts',
  },
  {
    id: 'T6',
    goal: 'Create src/auth/email-throttle.ts exporting `class EmailThrottle`, constructed as `new EmailThrottle(now: () => number)`, with `shouldSend(email: string): boolean` suppressing a repeat send inside a 60 second window, plus `keys(): string[]` exposing the throttle map keys for inspection.',
    allowedPaths: ['src/auth/email-throttle.ts'],
    requires: ['F7', 'F8'],
    plausibleWrong: 'stores the raw address as the key; Date.now(); case-sensitive keys',
    oracle: 'oracle/T6.email-throttle.test.ts',
  },
];

/** Applied in every arm, so the contract itself is never the differentiator. */
export const commonAcceptance = [
  { id: 'AC-typecheck', condition: 'The package typechecks (npm run typecheck)' },
  { id: 'AC-scope', condition: 'Only the declared path changed' },
];
