# Contributing to Entente

Thanks for helping make agent handoffs easier to understand and verify. Documentation, reproducible bugs, demo scenarios, lint rules, and adapters are all useful contributions. You do not need model credits or agent credentials to work on replay, protocol, or hermetic tests.

## Start with a small change

Follow the [README quick start](README.md#quick-start-no-agent-or-api-key), then choose one concrete outcome. For a first PR, improving an unclear replay instruction or adding a passing/failing case to an existing lint rule is a manageable starting point. These are suggested contribution types, not claims that an issue is already assigned or approved.

For product or protocol changes, open an issue describing the behavior you want and its acceptance criteria. Read [PRD.md](PRD.md), the relevant source and tests, and the shared contributor instructions in `AGENTS.md` when present. Existing runtime integrations belong behind ports; JSONL events remain the source of truth.

## Set up your fork

Fork the project in GitHub, clone your fork, and create a branch for the change:

```bash
git clone https://github.com/YOUR-USERNAME/entente.git
cd entente
git switch -c docs/clearer-replay-start
npm ci
npx tsc -b
```

Use Node.js 22+ and Git. Rust is needed only when building or changing the native crates. Live missions additionally need a configured runtime and terminal host; tests must use fakes instead.

## Find the right files and checks

| Change | Source | First check |
| --- | --- | --- |
| Lint rule | `packages/protocol/src/lint/rules/` | `npx vitest run packages/protocol/src/lint/lint.test.ts` |
| Lifecycle or repair behavior | `apps/relayd/src/orchestrator/`, `apps/relayd/src/repair/` | `npx vitest run apps/relayd/src/orchestrator/orchestrator.test.ts` |
| Evidence execution | `apps/relayd/src/verify/` | `npx vitest run apps/relayd/src/verify/check-runner.test.ts` |
| Runtime adapter | `apps/relayd/src/launch/runtimes/`, `apps/relayd/src/ports.ts` | `npx vitest run apps/relayd/src/launch/runtimes.test.ts` |
| Replay or UI | `apps/tui/`, `apps/cli/`, `fixtures/` | Replay the affected fixture and run the relevant package tests |
| Native terminal | `crates/termd/`, `crates/relay-tui/` | `cargo test -p termd` or `cargo test -p relay-tui` |
| Documentation | `README.md`, `docs/` | Check links and commands against the actual source; describe any command you could not run |

For behavior changes, finish with:

```bash
npx tsc -b
npx vitest run
```

For schema or event changes, include reducer tests, update relevant replay fixtures, and regenerate the protocol reference:

```bash
node scripts/gen-protocol-docs.mjs
```

Do not hand-edit `docs/protocol.md` or `docs/schema/*`. A new lint rule needs a `LintRuleId` entry and both a passing and a failing case. A replay-visible lifecycle change needs fixture coverage. Keep runtime, task, and handoff state distinct. Keep tests hermetic: temporary directories, injected executors, no network, no API keys, and no live LLM calls. A new runtime implements `AgentRuntime`; a new host implements `TerminalHost`.

Native changes also run `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`. Demo-app changes run `npm ci`, `npx vitest run`, and `npx tsc --noEmit` inside `demo-repo`. See the exact [CI workflow](.github/workflows/ci.yml).

## Open a reviewable PR

- State the concrete problem, expected behavior, and what changed.
- Keep the diff focused; preserve unrelated work and avoid committing local run data or reference repositories.
- Include the commands you ran and their actual results. Mark anything not run and explain why.
- Include a fixture or example when it makes the behavior reproducible. Remove credentials and private data from logs before sharing.
- Explain remaining limits, especially where execution evidence is different from semantic correctness.

Docs-only changes do not need a full live mission. Do not invent test results to fill a template.

## Report a bug or propose a scenario

Use the existing [issue forms](https://github.com/allenchenhan99/entente/issues/new/choose). A useful report includes the command, OS and Node version, expected versus actual behavior, and a minimal sanitized event log when relevant. For a scenario, identify which requirement is ambiguous, which check should fail, and what a successful repair would look like.

For interoperability proposals, treat A2A as the discovery/transport layer and focus Entente on software-delivery contracts, evidence, and repair semantics above it.
