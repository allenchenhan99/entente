# Conversation history (product owner ↔ engineering), most recent last

**[human] turn-1** — We need login before the demo. Passwordless only, no passwords, no OAuth.

**[agent] turn-2** — Two options: magic link (URL with a token, one click) or a 6-digit code typed into the form.
Both fit the existing EmailSender stub.

**[human] turn-3** — Support will hate the code option if people mistype it; design will hate the link option
because the email client strips it on some Android builds. I need to check with both teams.

**[agent] turn-4** — Understood. Either way: 15-minute expiry, single use, hash at rest, cookie session for /me.

**[human] turn-5** — Yes to all of that. Cookie should be called `session`, 24 hours.

**[human] turn-6** — I will decide link vs code tomorrow after the design sync. Do not pick for me.

**[agent] turn-7** — Noted. Everything except the mechanism is settled: request endpoint, verify endpoint,
expiry, single use, hashing, cookie, `/me`.

**[human] turn-8** — One more thing: unknown emails must look exactly like known ones from the outside.
