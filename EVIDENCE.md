# graph-model — Evidence

Branch: `wp/graph-model` (based on `b0c4d2e`). All work under `packages/protocol/src/graph/**`; `types.ts` untouched.

Commits:

- `401a4cf` test(graph): totality on escalation, budget, cancel and reject paths; share check tally helper
- `bd10031` feat(graph): storyFor and describe — narrated histories and static facts per object
- `f4ebb63` feat(graph): narrate — one present-tense English sentence per event type
- `d7ceac5` test(graph): actionsFor ordering, targets and per-object availability
- `77c7dae` feat(graph): buildGraph — nodes, edges and inbox derived from State

Changed files (`git diff --name-status b0c4d2e HEAD`):

```
A	packages/protocol/src/graph/actions.test.ts
A	packages/protocol/src/graph/actions.ts
A	packages/protocol/src/graph/build.test.ts
A	packages/protocol/src/graph/build.ts
A	packages/protocol/src/graph/common.ts
A	packages/protocol/src/graph/describe.test.ts
A	packages/protocol/src/graph/describe.ts
M	packages/protocol/src/graph/index.ts
A	packages/protocol/src/graph/narrate.test.ts
A	packages/protocol/src/graph/narrate.ts
A	packages/protocol/src/graph/story.test.ts
A	packages/protocol/src/graph/story.ts
A	packages/protocol/src/graph/testkit.test.ts
A	packages/protocol/src/graph/total.test.ts
```

```
 14 files changed, 1829 insertions(+), 22 deletions(-)
```

Interpretations of ambiguous contract fields are listed in `HANDOFF_NOTES.md` (questions 1–8); the main ones: a human
review counts as pending only while `handoff_state === 'evidence_submitted'`; `since` of a task question is the
proposal time (State has no "asked at"); the evidence edge appears once work has started.

## AC-1 — `buildGraph(replay(events-live-4))`

`npx vitest run packages/protocol/src/graph -t "live-4"`

```
 ✓ story.test.ts > storyFor > story of the planner on live-4 starts with the mission and its 6 questions, then the plans and integration
 ✓ build.test.ts > buildGraph > live-4 (planner asks first, serial chain) > final state: fixed nodes plus three verified agents
 ✓ build.test.ts > buildGraph > live-4 (planner asks first, serial chain) > final state: 3 verified contract edges, 3 verified evidence edges, 2 dependency edges, no reply edge
 ✓ build.test.ts > buildGraph > live-4 (planner asks first, serial chain) > after the first 3 events: a mission_question inbox item with 6 detail lines and a mission_clarify action
 ✓ build.test.ts > buildGraph > live-4 (planner asks first, serial chain) > while the chain is executing, the dependency edge carries the producer status and the consumer stays pending
 Test Files  2 passed | 5 skipped (7)
      Tests  5 passed | 55 skipped (60)
```

Asserted: nodes `human, planner, t-auth-routes, t-login-page, t-magic-link-core, verifier` (columns 0,0,1,1,1,2);
3 `contract` edges `v1 ✓` / verified; 3 `evidence` edges `✓` / verified; 2 `dependency` edges
(`dep:t-magic-link-core->t-auth-routes`, `dep:t-auth-routes->t-login-page`); no `reply` edge; inbox empty.
First 3 events: inbox `[mission_question]`, 6 detail lines `Q1: …`…`Q6: …`, action `{key:'a', kind:'mission_clarify'}`
with the six question ids, edge `question:mission` planner→human `? 6`.

## AC-2 — `buildGraph(replay(events-live-1))` at three points

`npx vitest run packages/protocol/src/graph -t "live-1"`

```
 ✓ build.test.ts > buildGraph > live-1 (human review fails, repair, blocker, verified) > after evidence_recorded with a pending human review: evidence edge needs attention and inbox has a human_review item
 ✓ build.test.ts > buildGraph > live-1 (human review fails, repair, blocker, verified) > after repair_requested: evidence edge label starts with AC-3 and needs attention
 ✓ build.test.ts > buildGraph > live-1 (human review fails, repair, blocker, verified) > after task_blocked: node badge ◐ blocked and a blocker inbox item with a reply action
 ✓ build.test.ts > buildGraph > live-1 (human review fails, repair, blocker, verified) > final state: contract edge verified, canceled frontend failed, inbox empty
 Test Files  1 passed | 6 skipped (7)
      Tests  4 passed | 56 skipped (60)
```

Asserted: after `repair_requested` the evidence edge is `AC-3 ✗`, `status: 'attention'`, `attention: true`;
after `task_blocked` the node badge is `◐ blocked`, status `blocked`, inbox `[blocker]` with a `{key:'r', kind:'reply'}`
action; final state: contract edge `v1 ✓` verified, evidence `✓` verified, inbox empty (the canceled frontend task is
`failed` and raises no item).

## AC-3 — `narrate` over every `EVENT_TYPES` member

`npx vitest run packages/protocol/src/graph -t "narrate"`

```
 ✓ narrate.test.ts > narrate > returns one non-empty sentence for every EVENT_TYPES member, never echoing the raw type
 ✓ narrate.test.ts > narrate > is total: every event type narrates on the initial state (unknown task/mission)
 ✓ narrate.test.ts > narrate > the eight pinned shapes > task_proposed
 ✓ narrate.test.ts > narrate > the eight pinned shapes > clarification_requested
 ✓ narrate.test.ts > narrate > the eight pinned shapes > task_accepted
 ✓ narrate.test.ts > narrate > the eight pinned shapes > check_failed
 ✓ narrate.test.ts > narrate > the eight pinned shapes > repair_requested
 ✓ narrate.test.ts > narrate > the eight pinned shapes > task_blocked
 ✓ narrate.test.ts > narrate > the eight pinned shapes > blocker_replied
 ✓ narrate.test.ts > narrate > the eight pinned shapes > mission_clarification_requested
 ✓ narrate.test.ts > narrate > voice and naming > names the human "you", relayd "RelayGraph", agents by role, and uses present tense
 ✓ narrate.test.ts > narrate > voice and naming > resolves the role from state when the actor is not the agent (relayd verifying backend)
 ✓ narrate.test.ts > narrate > voice and naming > truncates long quotes to 120 characters with an ellipsis
 Test Files  1 passed | 6 skipped (7)
      Tests  13 passed | 47 skipped (60)
```

Asserted: all 36 types yield a non-empty sentence that does not contain the raw type, `agent:` or `relayd`, both with a
known task and on the initial state. The eight pinned sentences match exactly, e.g.
`RelayGraph opens repair r1 for AC-2 only (2 repairs left)` and
`backend is stuck: waiting on schema (waiting on t-auth-schema)`. Quotes are clipped to 120 chars with `…`.

## AC-4 — `storyFor` and `describe`

`npx vitest run packages/protocol/src/graph -t "story|describe"`

```
 ✓ describe.test.ts > describe > contract edge after a failed check: every criterion with its check status
 ✓ describe.test.ts > describe > contract edge once verified: the human_review criterion counts as passed; unchecked criteria before evidence show no verdict
 ✓ describe.test.ts > describe > agent node: role, the three states, worktree, attempt and blocker
 ✓ describe.test.ts > describe > agent node with dependencies lists them with their state
 ✓ describe.test.ts > describe > verifier: criteria, machine-checked and mismatch counts from metrics
 ✓ describe.test.ts > describe > human: open inbox count; planner: mission title, status and open questions
 ✓ describe.test.ts > describe > inbox item: its title then detail
 ✓ describe.test.ts > describe > evidence, dependency, question and reply edges describe their facts; unknown refs are total
 ✓ story.test.ts > storyFor > story of the backend node on live-2: every backend event, in seq order, each with an HH:MM prefix
 ✓ story.test.ts > storyFor > story of the planner on live-4 starts with the mission and its 6 questions, then the plans and integration
 ✓ story.test.ts > storyFor > story of the human lists only human-actor events
 ✓ story.test.ts > storyFor > story of the verifier: checks, records, verifications and integration only
 ✓ story.test.ts > storyFor > story of a contract edge: proposal, lint, clarification, revision, acceptance of that task only
 ✓ story.test.ts > storyFor > story of an evidence edge: evidence, checks, human review, repair and verification of that task only
 ✓ story.test.ts > storyFor > story of a question edge, a reply edge and an inbox item
 ✓ story.test.ts > storyFor > is total: unknown refs and empty logs yield []
 Test Files  2 passed | 5 skipped (7)
      Tests  16 passed | 44 skipped (60)
```

Asserted: the backend story on live-2 has one line per backend event (≥ 8), in seq order, each prefixed with the
event's `HH:MM`; the planner story on live-4 starts `you create mission …` then
`planner asks you 6 questions before decomposing: Q1 …`; `describe(contract:t-backend-auth)` on the repair fixture lists
`AC-1 ✓ command: …`, `AC-2 ✗ command: … — GET /auth/verify … expected 401`, `AC-3 ⏳ human_review`, `AC-4 ✓ diff_scope`
and `versions: v1 → v2 (2 clarifications)`.

## AC-5 — whole repo typechecks, all protocol tests pass

`npx tsc -b && npx vitest run packages/protocol`

```
 Test Files  11 passed (11)
      Tests  137 passed (137)
```

Whole worktree gate, `npx tsc -b && npx vitest run`:

```
 Test Files  37 passed (37)
      Tests  314 passed (314)
```

STATUS: done
