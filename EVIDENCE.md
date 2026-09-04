# pane-cli Evidence

Branch: `wp/pane-cli`

Implementation commits:

- `2d18620 feat(cli): add pane list and get commands`
- `f608a86 feat(cli): add pane read input and run commands`
- `9ec2526 feat(cli): add pane wait and readiness commands`
- `c1e86a1 feat(cli): add pane lifecycle and cast commands`
- `73462dc fix(cli): align pane listing and preserve cast bytes`

## Git diff

Command: `git diff --stat origin/main...HEAD`

```text
 HANDOFF_NOTES.md         |  22 ++++
 apps/cli/src/cli.test.ts | 291 +++++++++++++++++++++++++++++++++++++++++++++-
 apps/cli/src/cli.ts      | 297 ++++++++++++++++++++++++++++++++++++++++++++++-
 3 files changed, 603 insertions(+), 7 deletions(-)
```

Command: `git diff --name-only origin/main...HEAD`

```text
HANDOFF_NOTES.md
apps/cli/src/cli.test.ts
apps/cli/src/cli.ts
```

`git diff --check origin/main...HEAD` exited 0 with no output. The pre-existing uncommitted `package-lock.json` change was preserved and excluded from every commit.

## AC-1

Implemented schema-validated pane listing and detail output. The list renders the required columns and focused marker; `get` prints all `PaneInfo` fields.

Command: `npx vitest run apps/cli -t "pane list|pane get"`

```text
Test Files  1 passed (1)
Tests       4 passed | 42 skipped (46)
exit 0
```

Assumption: frozen `pty.ts` documents `GET /panes` as `PaneInfo[]`, but that shape cannot identify focus. The parallel server returns `{ panes: PaneInfo[], focused_pane?: string }`. The CLI validates and accepts the server envelope, retains raw-array compatibility, and records the exact proposed frozen API diff in `HANDOFF_NOTES.md`.

## AC-2

Implemented screen reads with forwarded query parameters, input body handling with required text/keys, and command execution as text followed by `enter`. Screen and acknowledgement responses are validated.

Command: `npx vitest run apps/cli -t "pane read|pane input|pane run"`

```text
Test Files  1 passed (1)
Tests       6 passed | 40 skipped (46)
exit 0
```

## AC-3

Implemented exact-one match/regex validation, wait-result output and exit-code mapping, and shell-loop-friendly readiness output/exit codes. `WaitOutputResult` and `PaneReadiness` are validated.

Command: `npx vitest run apps/cli -t "wait-output|readiness"`

```text
Test Files  1 passed (1)
Tests       5 passed | 41 skipped (46)
exit 0
```

## AC-4

Implemented kill/focus POST routes and cast download to exact stdout bytes or a cwd-relative output file. A regression test verifies that newline-terminated cast data is not mutated.

Command: `npx vitest run apps/cli -t "kill|focus|cast"`

```text
Test Files  1 passed (1)
Tests       6 passed | 40 skipped (46)
exit 0
```

## AC-5

Command: `npx tsc -b && npx vitest run apps/cli`

```text
Test Files  1 passed (1)
Tests       46 passed (46)
exit 0
```

Additional whole-repository check: `npx tsc -b` exits 0. `npx vitest run` was also attempted; 352 of 360 tests passed, while eight existing relayd tests that open loopback or Unix-domain listeners could not run in this restricted sandbox (`listen EPERM` on `127.0.0.1` and the `tsx` IPC socket). No relayd files were changed, and the complete non-network CLI suite passes.

STATUS: done
