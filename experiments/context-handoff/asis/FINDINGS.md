# AS-IS: what delegation actually costs today

Measured, not estimated. Reproducible:

```sh
S="C:/Users/User/.claude/projects/D--vscode-python-unvisited/84912a87-292d-4007-8e84-e099d45205a2.jsonl"
node experiments/context-handoff/asis/extract.mjs "$S"      # what the main agent wrote
node experiments/context-handoff/asis/child-cost.mjs "$S"   # what the children then spent
```

Source: a real working session on an unrelated project (`unvisited`) — the only session in
that corpus (38 sessions, 178 MB) containing delegations. Logs are personal and large, so
nothing is vendored here.

**Claude Code persists each subagent's full transcript**, next to the parent session:

```
projects/<encoded-cwd>/<parent-session-id>/subagents/agent-<id>.jsonl
projects/<encoded-cwd>/<parent-session-id>/subagents/agent-<id>.meta.json
```

36 transcripts, 36 metas, 129 MB, matching the 36 delegations exactly. The meta carries
`toolUseId`, which joins back to the parent's `Agent` tool_use block — so "what was sent"
and "what it then cost" are one joinable row. That join is what makes the headline below
measurable rather than speculative.

## The session

```
lines         3587
delegations   36        (1 fork, 35 fresh general-purpose agents, spawnDepth 1)
compaction    lines 3183, 3184 — 35 delegations before, 1 after
children      36 transcripts joined by toolUseId
```

## Headline: the brief is 0.8% of a delegation's cost

Benchmark group, n=20 delegations, per delegation:

| | tokens |
| --- | --- |
| brief the main agent hand-wrote | ~1,608 |
| child output | ~5,346 |
| child input, excluding cache reads | ~194,236 |
| **brief as a share of the delegation's own footprint** | **0.8%** |

Whole session, all 36 children: 2,895 assistant turns, 1,656 tool calls, 163,086 output
tokens, and 258,842,822 cache-read tokens.

**An average child costs ~199,582 non-cache-read tokens — 124× the brief that launched it.**

This kills the obvious version of the optimisation. "Stop re-writing the same briefing and
reuse a checkpoint instead" targets 0.8% of the spend. Even if it were free, it would not
be worth building for the token saving.

## What survives, and it is much larger

`Run benchmark case19` was delegated **twice**. The second prompt says why:

> "a previous attempt at this exact case failed mid-task due to an account API rate limit
> (now reset). Check ... to confirm nothing case19-related was partially created and left
> in a broken state"

The two runs:

| | turns | output | cache_write | cache_read |
| --- | --- | --- | --- | --- |
| attempt 1 (failed) | 100 | 9,085 | 208,941 | 7,388,341 |
| attempt 2 | 43 | 607 | 114,487 | 3,054,553 |

**The wasted attempt burned 218,226 non-cache-read tokens — 6.8× the cost of all twenty
briefs combined.**

So the value of a good handoff is not that it saves prompt tokens. It is that **one
avoided re-run pays for every brief in the session, seven times over.** The economics are
entirely in rework, and rework is a quality outcome, not a size outcome.

This failure was an API rate limit rather than a missing fact, so it is a cost *analogue*,
not proof that context gaps cause re-runs. Establishing that link is precisely what the
controlled benchmark exists to do — see the caveat section.

## Redundancy: real, but not the headline

Across the 20 benchmark delegations the same standing facts were restated every time:

| restated in | fact |
| --- | --- |
| **20/20** | a standing decision — "Trip.Planner is broken via a CORS bug, do NOT test it" |
| **20/20** | a human instruction relayed from an earlier turn — "keep the write-up concise" |
| **20/20** | the evidence directory paths |
| 15/20 | findings accumulated from sibling children (case11/case14 results, coordinates "reuse from case03/04/06/15") |
| 3/20 | an interface fact (the day-count formula) |

**Exact line-level overlap between those prompts is only 10%.** The main agent did not
copy-paste; it re-expressed the same facts in different words each time:

```
case06: "section 7 (methodology corrections — IMPORTANT: Trip.Planner is confirmed
         broken via a CORS bug, do NOT test it, only test TripGenie)"

case07: "section 7 (Trip.Planner is CONFIRMED BROKEN via a CORS bug,
         do NOT test it, TripGenie only)"
```

The redundancy is **semantic, not lexical** — prompt caching and string dedup key on
identical text and cannot capture it; an item-based checkpoint keys on extracted facts and
can. That remains a true and useful observation about *mechanism choice*. It is just not,
on this evidence, an argument about *cost*.

## Three scenarios worth reproducing under control

**A human decision relayed by hand, 20 times.** One prompt says so outright: *"per
instruction from the user's supervisor (a prior turn in this session), keep your written
case summary CONCISE"*. Under the issue #4 model that is one item with `source_refs`
pointing at the human turn, tagged `human_confirmed` by derivation rather than re-asserted
as prose.

**A standard that evolved.** case06 says "match cases 01-05 but keep it concise"; case07
says "case06's writeup is a good template for concision". A `supersedes` relationship
carried by hand.

**A delegation across a compaction boundary.** Compaction lands at line 3183; case24
follows at 3229 and is the longest of all 36 (7,470 chars vs a ~6,400 pre-compaction
average). n=1 — an observation to reproduce, not a result.

## Corrections to an earlier reading of this data

Recorded because both errors would have changed the conclusion:

1. **"2,523 sidechain lines of child transcript" was wrong.** The grep matched the field
   name `isSidechain`, not its value; all 2,523 occurrences are `false`. `extract.mjs` now
   counts true and false separately and says so.
2. **"We have no child output" was also wrong.** The children's transcripts exist, in the
   `subagents/` directory beside the parent session — a location the first pass did not
   check, because it only examined the parent `.jsonl` file. 21 of 36 tool results in the
   parent are merely "Async agent launched successfully" acknowledgements, which is what
   made the output look absent from the parent's side alone.

The second error mattered a lot: it is the child transcripts that produced the 0.8%
headline, and without them this document would have concluded that brief redundancy was
the thing to optimise.

## Consequence for the benchmark design

The benchmark in the parent directory measures first-pass success and repair rounds, not
prompt size. This data says that is the right instrument, and sharpens the reporting rule:

- **Cost per *passed* task is the only meaningful figure.** A per-delegation token
  comparison would be measuring a 0.8% slice.
- **One extra repair round swamps every brief-size difference in the run.** With ~200k
  tokens per child, a single avoided re-run outweighs the entire arm-B/arm-C brief delta by
  two orders of magnitude.
- If arms A, B and C reach the same first-pass success rate, the honest conclusion is that
  the handoff machinery is **not justified** — the token argument alone will not save it.

## Cost floor found while validating the harness

`claude -p --output-format json` with the prompt "Reply with exactly: ok":

```
input_tokens                   2
cache_creation_input_tokens    23409
cache_read_input_tokens        0
output_tokens                  4
total_cost_usd                 0.235
```

Every spawn carries ~23k tokens of fixed system-prompt overhead, so a 600-token difference
in handed-over context is ~2.5% of a child's *first* turn and far less across a full run.
The same probe confirmed the field names used by `parseUsage()` — `input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`,
`total_cost_usd` — so usage accounting maps correctly rather than silently reading zero.
