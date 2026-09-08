/**
 * Deterministic item selection: given extracted items and a task contract, choose what
 * the child receives, under a token budget. No model call, no randomness — so it can be
 * tested without an LLM (see selftest.mjs), which is the point.
 *
 * The scoring is the structural one from issue #7 §4.2: path overlap and task vocabulary,
 * with provenance as a tie-breaker. Deliberately NOT entropy — a long stack trace has
 * high token entropy and no relevance, while "tokens expire after 15 minutes" has low
 * entropy and is the one thing the child must not get wrong.
 */

const STOP = new Set([
  'create', 'exporting', 'class', 'with', 'returning', 'that', 'from', 'plus', 'this',
  'null', 'number', 'string', 'boolean', 'unknown', 'record', 'array', 'const', 'true',
  'false', 'when', 'once', 'inside', 'again', 'method', 'constructed', 'export', 'value',
  'header', 'response', 'module', 'file', 'path', 'paths', 'their', 'each', 'into',
]);

const words = (goal) =>
  new Set((goal.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

/**
 * Relevance is a GATE, not a bonus. An item earns its place by being about this task's
 * files or vocabulary; provenance only breaks ties among items that are already relevant.
 * Without the gate, every human_confirmed item scores above zero and "selection"
 * degenerates into "send everything" — a different and much weaker claim.
 */
export function relevance(item, task) {
  const paths = task.allowedPaths.map((p) => p.toLowerCase());
  const text = `${item.text ?? ''}`.toLowerCase();
  const related = (item.related_paths ?? item.relatedPaths ?? []).map((p) => String(p).toLowerCase());
  let r = 0;
  if (related.some((rp) => paths.some((p) => p.includes(rp) || rp.includes(p)))) r += 6;
  for (const w of words(task.goal)) if (text.includes(w)) r += 1;
  return r;
}

export function score(item, task) {
  let s = relevance(item, task);
  if (item.kind === 'human_confirmed' || item.kind === 'check_verified') s += 2;
  if (Array.isArray(item.supersedes) && item.supersedes.length > 0) s += 1;
  return s;
}

const estimate = (item) => Math.ceil(String(item.text ?? '').length / 4) + 12;

export function selectItems(items, task, { budgetTokens = 250, gate = 2 } = {}) {
  const ranked = items
    .filter((it) => !it.superseded_by && !it.supersededBy)
    .filter((it) => relevance(it, task) >= gate)
    .map((it) => ({ it, s: score(it, task) }))
    .sort((a, b) => b.s - a.s || estimate(a.it) - estimate(b.it));

  const chosen = [];
  let spent = 0;
  const dropped = [];
  for (const { it } of ranked) {
    const cost = estimate(it);
    if (spent + cost > budgetTokens) {
      dropped.push(it.id ?? it.text?.slice(0, 30));
      continue;
    }
    chosen.push(it);
    spent += cost;
  }
  return { chosen, dropped, estimatedTokens: spent };
}

export const renderItems = (chosen) =>
  chosen.length === 0
    ? ''
    : [
        'Standing context (each line is a recorded decision; the tag is its provenance):',
        ...chosen.map((it) => `- [${it.kind ?? 'agent_reported'}] ${it.text}`),
      ].join('\n');
