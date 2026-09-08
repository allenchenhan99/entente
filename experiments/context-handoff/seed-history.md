# Seeded main-agent history

The prior conversation a main agent carries when it starts delegating. Facts are buried
in it conversationally, the way they actually arrive — not as a tidy list. Turn ids match
the `source_refs` in `facts.yaml`, so extraction can be scored against the answer key.

Two properties matter and must survive editing:

1. **`turn-12` is contradicted by `turn-31`.** Anything that carries the 30-minute value
   forward is wrong. This is the superseded case.
2. **Provenance differs by speaker.** `[human]` turns are the only source for
   `human_confirmed`; `[check]` turns are the only source for `check_verified`;
   `[agent]` turns can never be more than `agent_reported`, no matter how confident.

The harness pads between turns with `--history-tokens` of task-irrelevant material to
sweep history size. Padding never introduces or contradicts a fact.

---

**[human] turn-8** — On the dashboard, stick to the 4px spacing grid and keep styles in
the stylesheet. No inline styles, they've bitten us on theming twice.

**[agent] turn-9** — Understood. I'll keep spacing on the 4px grid and move the two
inline styles I find into the stylesheet.

**[human] turn-12** — For the magic link, let's say the token is good for 30 minutes.
That feels like enough for someone to get to their inbox.

**[agent] turn-13** — Noted, 30-minute expiry on magic-link tokens.

**[human] turn-19** — Important one: if someone requests a link for an address we don't
have, the response has to be indistinguishable from a real one. Same 202, same body, same
shape. Compliance flagged account enumeration on the old product and I don't want to
repeat it. Don't 404, don't return a different message, don't let the timing give it away.

**[agent] turn-20** — Agreed. Unknown and known addresses will both return 202 with an
identical body.

**[human] turn-23** — When you're doing the browser checks, resize to 1280x1400 before
you screenshot anything, otherwise the captures aren't comparable between runs.

**[human] turn-31** — Change of mind on the token window: make it 15 minutes, not 30.
And it has to be single-use — once it's consumed, a second attempt with the same token
fails even if we're still inside the window. Security review pushed back on the longer
window and I agree with them.

**[agent] turn-32** — Updating: magic-link tokens now expire after 15 minutes and are
single-use. The earlier 30-minute figure is superseded.

**[human] turn-37** — Don't revive the Redis session experiment. The in-memory store is a
deliberate choice for the demo and I don't want that argued again.

**[human] turn-44** — The rate limit on link requests should be 5 per hour per email
address. Not per IP — we tried per-IP and two people in the office behind the same NAT
locked each other out within an hour. Key it on the email.

**[agent] turn-45** — Switching the limiter key from IP to email, 5 per hour.

**[human] turn-49** — Release notes get drafted Mondays, and nothing auto-publishes.
A human presses the button.

**[human] turn-52** — Legal came back on log retention. Audit entries must never contain
the magic-link token or its hash — not even truncated. Log the opaque tokenId and nothing
that could be replayed.

**[agent] turn-53** — Understood. Audit entries will carry tokenId only; no token value
and no hash of it.

**[agent] turn-58** — While wiring the limiter I noticed the email throttle map was
holding raw addresses in memory. I changed the dedupe key to sha256 of the lowercased
address so plaintext addresses never sit in the map. I haven't written a test for this
yet, so treat it as my own observation rather than something proven.

**[check] t-session-cookie:AC-1:attempt2 — PASSED**
```
✓ sets a cookie named "session"
✓ marks it HttpOnly
✓ sets SameSite=Lax
✓ sets Path=/ and Max-Age=86400
```

**[check] t-audit:AC-2:attempt1 — PASSED**
```
✓ timestamps are ISO-8601 UTC ending in Z
```

**[check] t-session-store:AC-3:attempt1 — PASSED**
```
✓ SessionStore takes an injected now() and never calls Date.now() directly
✓ constructor rejects non-positive lifetimes
```
