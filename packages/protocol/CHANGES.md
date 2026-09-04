# @relay/protocol — changes by the protocol work package

No frozen file (`contract.ts`, `events.ts`, `state.ts`, `lint.ts`, `api.ts`, `mcp.ts`) was edited.

## New exports (appended to `src/index.ts` via `export * from './lint/index.js'`)

| export | kind | purpose |
|---|---|---|
| `lintContract(contract, ctx): LintResult[]` | function | runs all static communication-debt rules (PRD §11) |
| `runtimeLint(state, now): LintResult[]` | function | `stale_handoff` / `long_block` warnings from derived `State`; `now` is injected |
| `STATIC_RULES` | `readonly LintRule[]` | the 11 static rules in report order |
| `RUNTIME_LINT_THRESHOLD_MS` | const | 5 minutes |

Individual rules are importable from `@relay/protocol/dist/lint/rules/<rule_id>.js` but are not re-exported
from the package root. `interpretation_drift` is not implemented (out of scope, LLM-based).

## Replaced

- `src/reducer.ts` — stub replaced by the full reducer. Signatures unchanged:
  `reduce(state, event): State`, `replay(events, from?): State`.
