# Conversation history (product owner, engineering agent, CI), oldest first

**[human] turn-1** — Login is passwordless: magic link by email. Keep the token store and the email throttle as two
small modules so the frontend team can stub them.

**[agent] turn-2** — Plan: `TokenStore` (create/consume) and `EmailThrottle` (shouldSend). I will hash tokens at rest.

**[human] turn-3** — Good. Hash at rest is non-negotiable.

**[human] turn-4** — Token TTL: 15 minutes.

**[agent] turn-5** — Set TTL to 15 minutes.

**[agent] turn-6** — I tested the expiry path manually; it works. *(no test was committed)*

**[human] turn-7** — Throttle: one email per address per 60 seconds.

**[agent] turn-8** — Implemented the throttle map keyed by the address.

**[human] turn-9** — Keying the map by the plaintext address is fine for now.

**[check] turn-10** — CI: 12 tests passed on the session-store module (unrelated to auth).

**[agent] turn-11** — Throttle verified end to end. *(agent-reported)*

**[human] turn-12** — Side topic: the OAuth button palette. Design wants #1a73e8 for the primary button.

**[agent] turn-13** — Noted the palette; not touching auth for that.

**[human] turn-14** — Also the footer links should open in the same tab.

**[agent] turn-15** — Footer change queued for the frontend task.

**[human] turn-16** — Back to auth. Support says 15 minutes is too short for people who open email on another device.

**[human] turn-17** — Make the token TTL 30 minutes.

**[agent] turn-18** — TTL is now 30 minutes.

**[agent] turn-19** — Re-ran my manual expiry check at 30 minutes; fine. *(agent-reported)*

**[human] turn-20** — Security review came back. Two changes.

**[human] turn-21** — First: the throttle map must not hold plaintext addresses. Key it by the SHA-256 hex of the
lowercased, trimmed address.

**[agent] turn-22** — Will do: key = sha256(lowercase(trim(email))).

**[human] turn-23** — Second: no logout endpoint in this iteration, and no "resend" endpoint either. Just the store and the throttle.

**[agent] turn-24** — Removed the resend stub I had started. *(unverified)*

**[human] turn-25** — Security also disagrees with support about the TTL.

**[human] turn-26** — Final answer on TTL: 10 minutes. Security wins. This overrides turn-17.

**[agent] turn-27** — Understood: 10 minutes, and a token is invalid at exactly 10 minutes.

**[agent] turn-28** — I believe the 30-minute value is still in one test fixture; will fix. *(agent-reported)*

**[human] turn-29** — Also: hash comparison must be on the hash, never on the raw token.

**[human] turn-30** — Ship it when tests are green.
