/**
 * Internal ports of relayd. Each is owned by exactly one work package (see docs/plans):
 *   EventStore, HttpApi, McpServer     → relayd-core
 *   WorktreeManager, Verifier, RepairPolicy → verify
 *   TerminalHost, AgentRuntime         → launch
 * The wiring in src/index.ts (relayd-core) composes them. Do not change these signatures
 * without updating every implementer.
 */
import type {
  Event, EventInput, State, TaskContract, TaskView, EvidenceSubmission, EvidenceRecord, RepairContract, RuntimeKind,
} from '@relay/protocol';

export interface EventStore {
  append(input: EventInput): Event;
  all(sinceSeq?: number): Event[];
  state(): State;
  subscribe(listener: (event: Event, state: State) => void): () => void;
}

export interface WorktreeInfo { path: string; branch: string; base: string }

export interface WorktreeManager {
  /** Creates .relay/wt/<task-id> on branch relay/<task-id>, based on repo HEAD with every dependency branch merged in order. */
  create(repoRoot: string, task: TaskContract, dependencyBranches: string[]): Promise<WorktreeInfo>;
  remove(repoRoot: string, taskId: string): Promise<void>;
  /** Working-tree + committed changes relative to the worktree's base. */
  diff(worktreePath: string, base: string): Promise<{ patchPath: string; changedFiles: string[] }>;
  /** Merges branches in order into relay/integration; returns conflict on first failure. */
  integrate(repoRoot: string, branches: string[]): Promise<{ branch: string; conflict?: { branch: string; files: string[] } }>;
  /**
   * Commits everything in the worktree (tracked and untracked) so the branch carries exactly the state that
   * was verified. Agents do not always commit; integration must never merge less than what was checked.
   */
  commitAll(worktreePath: string, message: string): Promise<{ committed: boolean; sha?: string }>;
  /**
   * Merges `branch` into the worktree at `worktreePath` (agent networking: a verified subtask's branch lands in
   * its parent's worktree). On conflict the merge is aborted and the conflicting files are returned.
   */
  mergeBranch(worktreePath: string, branch: string): Promise<{ merged: boolean; conflict?: string[] }>;
}

export interface CheckRunner {
  /** Runs every criterion's check for one attempt; emits check_passed/check_failed via the store; returns the record. */
  run(task: TaskView, submission: EvidenceSubmission, worktree: WorktreeInfo, evidenceDir: string): Promise<EvidenceRecord>;
}

export type RepairDecision =
  | { kind: 'verified' }
  | { kind: 'pending_human'; criteria: string[] }
  | { kind: 'repair'; repair: RepairContract }
  | { kind: 'escalate'; reason: string; failed_criteria: string[] }
  | { kind: 'failed_budget'; reason: string };

export interface RepairPolicy {
  decide(task: TaskView, record: EvidenceRecord): RepairDecision;
}

export interface SpawnOptions {
  name: string;               // unique live agent name, [a-z][a-z0-9_-]{0,31}
  cwd: string;
  argv: string[];             // command line without the initial prompt, argv[0] is the executable
  env: Record<string, string>;
  /**
   * Initial prompt to deliver once the agent is interactive. The host waits for readiness (screen model),
   * pastes it (bracketed paste when enabled) and presses Enter, retrying while the composer still holds it.
   */
  prompt?: string;
  /** Task the pane will host (recipient panes); shown in PaneInfo / HostMetrics. */
  taskId?: string;
}

export interface TerminalHost {
  readonly kind: 'relay' | 'relayterm';
  spawn(opts: SpawnOptions): Promise<{ paneId: string }>;
  focus(paneId: string): Promise<void>;
  isAlive(paneId: string): Promise<boolean>;
  kill(paneId: string): Promise<void>;
}

export interface LaunchSpec {
  taskId: string;
  token: string;
  mcpUrl: string;
  sessionId: string;
  cwd: string;
  role: 'planner' | 'recipient';
  contractSummary: string;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  /** Writes any per-agent config files under configDir and returns the argv/env to spawn plus the bootstrap prompt. */
  prepare(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string>; prompt?: string }>;
  /**
   * Wire an agent the human started themselves: the flags and env to add to *their* command line.
   *
   * Deliberately not `prepare` minus the executable. `prepare` equips an agent nobody is watching, so
   * it turns permission prompts off and pins the tool list — isolation there comes from the worktree
   * and the contract. Here a person is sitting in front of the terminal: they answer their own
   * dialogs, and restricting their tools would take away the agent they chose to open. All adoption
   * adds is the MCP wiring and the instructions, and it leaves everything else to them.
   */
  adopt?(spec: LaunchSpec, configDir: string, instructions: string): Promise<{ argv: string[]; env: Record<string, string> }>;
  /**
   * Resume an earlier session of this agent (daemon restart): same config, argv that reopens `spec.sessionId`
   * (`claude --resume <id>`, `codex resume <id>`), and a short prompt telling the agent to continue via relay_get_contract.
   */
  resume?(spec: LaunchSpec, configDir: string): Promise<{ argv: string[]; env: Record<string, string>; prompt?: string }>;
}
