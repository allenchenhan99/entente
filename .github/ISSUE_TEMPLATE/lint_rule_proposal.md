---
name: Lint rule proposal
about: A new communication-debt rule for Task Contracts
labels: lint
---

**Rule id** (snake_case) and **severity** (error blocks spawning; warning is shown):

**What it catches** — the coordination failure this prevents, with an example contract that should trigger it
and one that should not:

**Where**: one file in `packages/protocol/src/lint/rules/`, exporting `rule: LintRule`, plus the id in
`LintRuleId` (`packages/protocol/src/lint.ts`) and a positive + negative test.
