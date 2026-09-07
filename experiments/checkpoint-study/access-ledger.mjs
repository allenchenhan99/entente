import ts from 'typescript';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');

/** Parse, never evaluate, agent-authored JavaScript. Dynamic commands remain explicitly unresolved. */
export function commandCandidates(input) {
  const source = ts.createSourceFile('tool.js', input, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const commands = [];
  const visit = node => {
    if (ts.isCallExpression(node) && /^(?:await\s+)?tools[.[]/.test(node.expression.getText(source))) {
      const object = node.arguments[0];
      if (object && ts.isObjectLiteralExpression(object)) {
        const property = name => object.properties.find(p => ts.isPropertyAssignment(p) && (p.name.getText(source).replace(/^['"]|['"]$/g, '') === name));
        const cmd = property('cmd'), cwd = property('workdir');
        if (cmd) {
          const literal = ts.isStringLiteralLike(cmd.initializer);
          commands.push({ command: literal ? cmd.initializer.text : null,
            ...(cwd && ts.isStringLiteralLike(cwd.initializer) ? { workdir: cwd.initializer.text } : {}),
            dynamic: !literal, ...(!literal ? { expression: cmd.initializer.getText(source) } : {}) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return commands;
}

export function accessLedger(rollouts, timeline, startedAt) {
  const calls = new Map(), outputs = new Map();
  const epoch = Date.parse(startedAt);
  for (const { actor, events } of rollouts) for (const event of events) {
    if (event.type !== 'response_item') continue;
    const p = event.payload ?? {}, key = `${actor}:${p.call_id}`;
    if (['custom_tool_call_output', 'function_call_output'].includes(p.type)) {
      if (outputs.has(key) && JSON.stringify(outputs.get(key)) !== JSON.stringify(p.output)) throw new Error(`conflicting tool output ${key}`);
      outputs.set(key, p.output); continue;
    }
    if (!['custom_tool_call', 'function_call'].includes(p.type)) continue;
    const input = p.input ?? p.arguments ?? '';
    if (calls.has(key)) {
      if (calls.get(key).input !== input) throw new Error(`conflicting tool input ${key}`);
      continue;
    }
    const elapsed = Date.parse(event.timestamp) - epoch;
    const childStep = /^t-step-(\d+)$/.exec(actor);
    const step = childStep ? Number(childStep[1]) : timeline.filter(e => e.type === 'step_started' && e.elapsed_ms <= elapsed).at(-1)?.step ?? 0;
    let commands = [];
    if (p.type === 'custom_tool_call') commands = commandCandidates(input);
    else {
      try {
        const args = JSON.parse(input);
        if (typeof args.cmd === 'string') commands = [{ command: args.cmd, dynamic: false, ...(args.workdir ? { workdir: args.workdir } : {}) }];
      } catch { /* Retain raw input for review; do not invent an extracted command. */ }
    }
    calls.set(key, { actor, call_id: p.call_id, timestamp: event.timestamp, step, tool: p.name, input,
      input_sha256: digest(input), commands, classification: 'unreviewed', facts: [], source_revisions: [], rationale: '' });
  }
  return [...calls].map(([key, call]) => ({ ...call, output: outputs.get(key) ?? null,
    output_sha256: outputs.has(key) ? digest(JSON.stringify(outputs.get(key))) : null,
  })).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)) || a.actor.localeCompare(b.actor));
}
