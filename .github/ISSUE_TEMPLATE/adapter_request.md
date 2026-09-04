---
name: Adapter request
about: Support another agent runtime (Gemini CLI, Aider, ...) or terminal host (Zellij, WezTerm, ...)
labels: adapter
---

**Runtime or host**:

**How it is started unattended** (CLI flags, config file location, how MCP servers are configured, how an
initial prompt is delivered, any first-run dialogs such as folder trust or tool approval):

**Interface to implement**: `AgentRuntime` or `TerminalHost` in `apps/relayd/src/ports.ts`. Existing examples:
`apps/relayd/src/launch/runtimes/*.ts`, `apps/relayd/src/launch/hosts/*.ts`. Tests inject a fake executor, so
no real process is started in CI.
