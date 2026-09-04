# cli-explain evidence

Branch: `wp/cli-explain`  
Base: `b0c4d2e`

The conservative implementation keeps the existing `relay replay` command unchanged, injects the frozen `GraphApi` through `CliIo`, and shares one source loader across `inbox`, `explain`, and `story`. Live mode always reads `GET /state` and `GET /events/log?since=0`; explainability replay mode validates the JSONL as protocol events and derives state with `replay` from `@relay/protocol` without fetching.

## AC-1

Command:

```text
npx vitest run apps/cli -t "inbox"
```

Trimmed output:

```text
Test Files  1 passed (1)
Tests       3 passed | 25 skipped (28)
exit code   0
```

Coverage includes two rendered inbox blocks with exact clarify/review commands, the required empty message, and a replay file whose injected fetch throws if called.

## AC-2

Command:

```text
npx vitest run apps/cli -t "explain"
```

Trimmed output:

```text
Test Files  1 passed (1)
Tests       4 passed | 24 skipped (28)
exit code   0
```

Coverage includes fake `describe` plus `storyFor` output, an unknown ref returning exit 2 with all valid refs, an empty placeholder graph, and invalid-ref behavior when that graph is empty.

## AC-3

Command:

```text
npx vitest run apps/cli -t "story"
```

Trimmed output:

```text
Test Files  1 passed (1)
Tests       3 passed | 25 skipped (28)
exit code   0
```

The story test proves exact `task_id` filtering, delegates each retained event to the fake `narrate`, and checks the `HH:MM  ` prefix.

## AC-4

Command:

```text
npx tsc -b && npx vitest run apps/cli
```

Trimmed output:

```text
Test Files  1 passed (1)
Tests       28 passed (28)
exit code   0
```

## Git diff and changed files

Command:

```text
git diff --check b0c4d2e..HEAD
git diff --name-only b0c4d2e..HEAD
git diff --stat b0c4d2e..HEAD
```

Trimmed output:

```text
apps/cli/src/cli.test.ts
apps/cli/src/cli.ts
 apps/cli/src/cli.test.ts | 232 ++++++++++++++++++++++++++++++++++++++++++++++-
 apps/cli/src/cli.ts      | 187 +++++++++++++++++++++++++++++++++++++-
 2 files changed, 416 insertions(+), 3 deletions(-)
```

`git diff --check` produced no output. The pre-existing unstaged `package-lock.json` change was not modified or staged.

Commits:

```text
4df3522 fix(cli): distinguish empty graphs from invalid refs
9793841 test(cli): cover explainability edge cases
597cf67 feat(cli): narrate mission story
9954c36 feat(cli): explain graph objects
b140621 feat(cli): add explainability inbox command
```

## Full repository verification

The exact contract-level command was run on the final tree:

```text
npx tsc -b && npx vitest run
```

TypeScript completed and Vitest reported `28 passed` files / `255 passed` tests, plus eight failures in two Relayd suites that require opening sockets. The sandbox rejects the underlying operations before application behavior runs:

```text
apps/relayd/src/http/boot.test.ts
Error: listen EPERM: operation not permitted .../tsx-501/*.pipe

apps/relayd/src/mcp/server.test.ts
Error: listen EPERM: operation not permitted 127.0.0.1

Test Files  2 failed | 28 passed (30)
Tests       8 failed | 255 passed (263)
exit code   1
```

A direct Node `net.Server.listen(0, "127.0.0.1")` probe also returned `EPERM listen`, confirming an execution-sandbox restriction rather than a CLI regression. With only those two socket-bound suites excluded, the final tree passes all remaining repository tests:

```text
npx vitest run --exclude apps/relayd/src/http/boot.test.ts --exclude apps/relayd/src/mcp/server.test.ts
Test Files  28 passed (28)
Tests       255 passed (255)
exit code   0
```

STATUS: done
