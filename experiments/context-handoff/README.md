# Context-handoff cost benchmark

> Status: **case defined, harness written, not yet run.** No numbers here are measured.
> This experiment exists to decide whether the context-handoff work in issue #4 is worth
> building — it must be able to return "no".

## The question

When a main agent delegates to a subagent, how much does the handoff cost, and does a
structured, reusable handoff beat the main agent re-authoring a brief every time?

Cost is **not** just the prompt. A child that was not told a standing constraint writes
something plausible but wrong, fails its check, and gets repaired. The repair is the
expensive part. So the benchmark measures tokens **and** first-pass success.

## Why this case is shaped the way it is

Derived from a real session (`D:\vscode_python\unvisited`, session `84912a87`, 36
delegations, 2 compaction points, 2523 sidechain lines). Measured facts from that session:

| Observation | Number |
| --- | --- |
| Near-identical benchmark delegations | 20 |
| Total characters the main agent hand-wrote for them | 128,654 (~32k tokens) |
| A standing decision ("Trip.Planner is broken, do not test it") restated | 20/20 |
| A human instruction from an earlier turn ("keep summaries concise") restated | 20/20 |
| Evidence directory paths restated | 20/20 |
| **Exact line-level overlap between those prompts** | **10%** |

The last row is the important one. The main agent did **not** copy-paste; it re-expressed
the same facts in different words every time:

```
case06: "Trip.Planner is confirmed broken via a CORS bug, do NOT test it, only test TripGenie"
case07: "Trip.Planner is CONFIRMED BROKEN via a CORS bug, do NOT test it, TripGenie only"
```

So the redundancy is **semantic, not lexical**. Prompt caching, string dedup and
copy-paste templates cannot capture it. An item-based checkpoint can. This benchmark is
built to test exactly that claim, and to falsify it if it is wrong.

## Experimental design

### The trick that makes this measurable

Every task has an acceptance check that depends on a fact **which is not in the
repository**. `demo-repo/README.md` says "There is no login or auth of any kind", and
none of the policy facts below appear in its source. The facts exist only in the seeded
conversation history.

A child that does not receive the fact writes the plausible default (60-minute expiry,
per-IP rate limiting, raw-email keys, 404 for unknown accounts), fails its check, and
costs a repair round. That difference is the signal.

**The oracle tests are never given to the child.** The harness copies them into the
worktree only at verification time. If the child could read the test, it would learn the
fact from the test and every arm would pass.

### Arms

| Arm | What the child receives | Represents |
| --- | --- | --- |
| **A** | Contract only (goal, scope, acceptance criteria) | Today's `relay_get_contract` — the baseline |
| **B** | Contract + a brief the main agent writes for this child, from its own accumulated history | What a main agent does today by hand (the `unvisited` pattern) |
| **C** | Contract + items selected from one extraction over the same history | The issue #4 design |

Arm B pays main-agent output tokens on **every** delegation. Arm C pays extraction
**once** and near-zero per delegation. Whether that saving survives contact with quality
is the whole question.

### Accumulated history is a parameter, not a constant

`seed-history.md` is the main agent's prior conversation with the facts buried in it. The
harness pads it with `--history-tokens N` of task-irrelevant material so history size can
be swept. This matters because:

- Arm B's cost should grow with history size (the main agent re-reads more to write each brief).
- Arm C's per-delegation cost should stay flat (selection is deterministic over extracted items).
- Above some size the main agent compacts, and arm B should start **losing facts** — the
  failure mode the design claims to fix.

Sweep at minimum `--history-tokens 8000` and `60000`. Report both.

## Facts and tasks

Eight standing facts (`facts.yaml`), six tasks (`tasks.yaml`), each task depending on at
least one fact. Coverage is deliberate:

- `F1` (token TTL) is **superseded** — history contains an earlier 30-minute decision and
  a later 15-minute one. A handoff that carries the stale value fails.
- `F8` (injected clock) is depended on by three tasks — this is what item **reuse** looks like.
- `F2`, `F3`, `F5` are `human_confirmed` — they exist only because a human said so, and no
  amount of reading the code recovers them.
- `F7` is `agent_reported` — discovered by an earlier child, so it tests whether findings
  propagate between siblings.

## Metrics

Recorded per delegation, per arm, into `results/<run-id>.jsonl`:

```
main_output_tokens        main agent's cost to produce this brief (arm B only)
main_input_uncached       \
main_input_cache_read      > kept separate; never summed into one "input" number
main_input_cache_write    /
child_input_*             same split, for the child
child_output_tokens
extraction_tokens         arm C only, amortised across the run, recorded once
repair_rounds             0 or 1
check_passed              first-pass result, before any repair
check_passed_after_repair
wall_clock_ms
```

Reporting rules, following issue #4 §4:

- **Total cost includes failed runs.** The denominator is tasks passed; the numerator is
  every token spent, including repairs and the extraction pass.
- Cached and uncached input are never added together into a single figure.
- If a runtime does not report usage, record `unknown` — never `0`.
- `PaneTimings` / `HostMetrics` are readiness instrumentation, not billing. Do not use them here.

## Success criteria, fixed before running

State these before looking at any output, so the result can be negative:

1. **Quality gate first.** Arm C's first-pass success must be ≥ arm B's. If C is cheaper
   but loses facts, that is a failure, not a win.
2. **Then cost.** Report total cost per *passed* task for each arm.
3. If arm A already matches B and C on success rate, then this repository's tasks do not
   depend enough on accumulated context, and **the honest conclusion is that the handoff
   machinery is not justified by this evidence** — say so, and do not ship it on
   principle alone.
4. Six tasks × 3 arms is a pilot, not a significance test. Report the spread across
   repeats, not a single number.

## Running

Check the selector first — it costs nothing and it gates everything else. If it cannot
pick the right facts out of a *perfect* extraction, arm C's numbers would be measuring
selector bugs rather than the design:

```sh
node experiments/context-handoff/selftest.mjs
```

Then install demo-repo's dependencies once in the main checkout. The harness copies
`demo-repo/node_modules` into each worktree; without it, every arm pays a fresh
`npm install` and the wall-clock numbers become noise:

```sh
cd demo-repo && npm install && cd ..
```

Then:

```sh
node experiments/context-handoff/run.mjs --arm A --history-tokens 8000
node experiments/context-handoff/run.mjs --arm B --history-tokens 8000
node experiments/context-handoff/run.mjs --arm C --history-tokens 8000
node experiments/context-handoff/run.mjs --report
```

Each run needs a working `claude` CLI and makes real model calls. It writes only inside
`experiments/context-handoff/results/` and disposable git worktrees under
`.worktrees/ctxbench-*`, which it removes on exit.

**The usage field names in the runtime's JSON output are not assumed.** On first run the
harness dumps the raw usage object next to the parsed one so the mapping can be checked
rather than trusted. Fix `parseUsage()` if the shape differs; do not let a rename become
a silent zero.

## What this does not test

- Pull-B (deriving items from a runtime's own conversation tree) — no runtime adapter exists.
- Grandchildren — the orchestrator caps delegation at two layers (`orchestrator.ts:523`).
- Cross-mission resource contention — different concern, different experiment.
