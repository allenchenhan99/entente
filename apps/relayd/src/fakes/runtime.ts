/** In-memory AgentRuntime: writes nothing, returns a fake argv and records the launch spec. */
import type { RuntimeKind } from '@relay/protocol';
import type { AgentRuntime, LaunchSpec } from '../ports.js';

export interface FakeRuntime extends AgentRuntime {
  calls: Array<{ spec: LaunchSpec; configDir: string; mode?: 'resume' | 'adopt' }>;
  resume(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string>; prompt?: string }>;
  adopt(spec: LaunchSpec, configDir: string, instructions: string): Promise<{ argv: string[]; env: Record<string, string> }>;
}

export function fakeRuntime(kind: RuntimeKind): FakeRuntime {
  const env = (spec: LaunchSpec) => ({ RELAY_TOKEN: spec.token, RELAY_MCP_URL: spec.mcpUrl, RELAY_SESSION_ID: spec.sessionId });
  const rt: FakeRuntime = {
    kind,
    calls: [],
    async prepare(spec, configDir) {
      rt.calls.push({ spec: { ...spec }, configDir });
      return { argv: ['fake-agent', kind, spec.taskId], env: env(spec) };
    },
    /** Adopting a hand-started agent: argv carries the instructions so tests can see they arrived. */
    async adopt(spec, configDir, instructions) {
      rt.calls.push({ spec: { ...spec }, configDir, mode: 'adopt' });
      return { argv: ['--fake-mcp', spec.mcpUrl, '--fake-instructions', instructions], env: env(spec) };
    },
    /** Daemon restart: argv names the session so tests can assert the recorded id was reused. */
    async resume(spec, configDir) {
      rt.calls.push({ spec: { ...spec }, configDir, mode: 'resume' });
      return { argv: ['fake-agent', 'resume', spec.sessionId], env: env(spec) };
    },
  };
  return rt;
}
