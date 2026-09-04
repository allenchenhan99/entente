/** In-memory AgentRuntime: writes nothing, returns a fake argv and records the launch spec. */
import type { RuntimeKind } from '@relay/protocol';
import type { AgentRuntime, LaunchSpec } from '../ports.js';

export interface FakeRuntime extends AgentRuntime {
  calls: Array<{ spec: LaunchSpec; configDir: string }>;
}

export function fakeRuntime(kind: RuntimeKind): FakeRuntime {
  const rt: FakeRuntime = {
    kind,
    calls: [],
    async prepare(spec, configDir) {
      rt.calls.push({ spec: { ...spec }, configDir });
      return {
        argv: ['fake-agent', kind, spec.taskId],
        env: { RELAY_TOKEN: spec.token, RELAY_MCP_URL: spec.mcpUrl, RELAY_SESSION_ID: spec.sessionId },
      };
    },
  };
  return rt;
}
