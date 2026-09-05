#!/usr/bin/env node
/**
 * Deterministic self-test for the selector. No model calls, no network.
 *
 *   node experiments/context-handoff/selftest.mjs
 *
 * This must pass before spending money on a run. If the selector cannot pick the right
 * facts from a PERFECT extraction, arm C is broken before the benchmark starts and any
 * number it produces would be measuring the selector's bugs rather than the design.
 */
import { facts, distractors, tasks } from './case.mjs';
import { selectItems } from './select.mjs';

// Distractors are given a `kind` here on purpose. A real extraction assigns kinds to
// everything, so a selector that only survives because distractors lack provenance is
// being flattered by the fixture.
const live = [
  ...facts.filter((f) => !f.superseded_by),
  ...distractors.map((d) => ({ ...d, kind: 'human_confirmed' })),
];
const stale = facts.filter((f) => f.superseded_by).map((f) => f.id);

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };

console.log(`selector self-test — ${live.length} live items (${stale.length} superseded held back)\n`);
console.log('task  requires    selected                  recall  distractors  stale');

for (const task of tasks) {
  const { chosen } = selectItems(live, task);
  const ids = chosen.map((c) => c.id);
  const hit = task.requires.filter((r) => ids.includes(r));
  const noise = ids.filter((i) => i.startsWith('D'));
  const carried = ids.filter((i) => stale.includes(i));

  console.log(
    `${task.id}    ${task.requires.join('+').padEnd(10)}  ${ids.join(',').padEnd(24)}  ` +
    `${hit.length}/${task.requires.length}     ${String(noise.length).padStart(6)}  ${String(carried.length).padStart(6)}`,
  );

  if (hit.length !== task.requires.length) {
    fail(`${task.id} missed ${task.requires.filter((r) => !ids.includes(r)).join(',')} — arm C cannot beat arm A on this task`);
  }
  if (carried.length > 0) fail(`${task.id} carried superseded ${carried.join(',')} — the child would ship a stale decision`);
  if (noise.length > 1) fail(`${task.id} pulled in ${noise.length} distractors — precision is too low to claim a cost win`);
}

// Superseded items must never be selectable, even when they look relevant.
const t3 = tasks.find((t) => t.id === 'T3');
const withStale = selectItems([...live, ...facts.filter((f) => f.superseded_by)], t3);
if (withStale.chosen.some((c) => stale.includes(c.id))) {
  fail('a superseded fact was selected when present in the pool — supersession is not being honoured');
}

console.log(failures === 0 ? '\nselector OK' : `\n${failures} failure(s) — fix before running the benchmark`);
process.exit(failures === 0 ? 0 : 1);
