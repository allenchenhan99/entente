/**
 * MCP server (PRD §8). Every tool from `@relay/protocol` mcp.ts is registered with its zod input
 * schema. The caller is identified by `Authorization: Bearer <token>`; tokens are issued by the
 * orchestrator (task token for recipients, `mission:<id>` token for the planner).
 *
 * Stateless streamable HTTP: a fresh McpServer + transport per request (the SDK forbids reusing a
 * stateless transport across requests), mounted on the shared Hono app at `routes.mcp`.
 */
import type { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  RECIPIENT_TOOLS, PLANNER_TOOLS, routes,
  RespondInput, AwaitContractInput, ReportProgressInput, ReportBlockerInput, SubmitEvidenceInput, AwaitVerdictInput, AwaitReplyInput,
  ProposeSubtaskInput, AwaitTaskInput,
  ProposeTaskInput, ReviseTaskInput, AnswerClarificationInput, AskHumanInput, AwaitAnswersInput,
} from '@relay/protocol';
import type { Orchestrator, TokenSubject } from '../orchestrator/orchestrator.js';
import { RELAYD_VERSION } from '../config.js';

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

const bearer = (header: string | undefined): string | undefined => header?.match(/^Bearer\s+(\S+)$/i)?.[1];

/** Builds a server whose tools are bound to one caller (or to no caller at all). */
export function buildMcpServer(orchestrator: Orchestrator, subject: TokenSubject | undefined, hasToken: boolean): McpServer {
  const server = new McpServer({ name: 'relayd', version: RELAYD_VERSION });

  const guard = async (fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return fail((err as Error)?.message ?? String(err));
    }
  };
  const asRecipient = (fn: (taskId: string) => Promise<CallToolResult> | CallToolResult) =>
    guard(() => {
      if (!subject) return fail(hasToken ? 'unknown token' : 'missing Authorization: Bearer <task_token>');
      if (subject.kind !== 'task') return fail('this tool is for recipient agents; the planner token cannot call it');
      return fn(subject.taskId);
    });
  const asPlanner = (fn: (missionId: string) => Promise<CallToolResult> | CallToolResult) =>
    guard(() => {
      if (!subject) return fail(hasToken ? 'unknown token' : 'missing Authorization: Bearer <mission_token>');
      if (subject.kind !== 'mission') return fail('this tool is for the planner; a recipient task token cannot call it');
      return fn(subject.missionId);
    });
  const ownedTask = (missionId: string, taskId: string) => {
    const view = orchestrator.taskView(taskId);
    if (!view) throw new Error(`task ${taskId} not found`);
    if (view.mission_id !== missionId) throw new Error(`task ${taskId} belongs to another mission`);
  };

  // ---- recipient tools ----
  server.registerTool(RECIPIENT_TOOLS.get_contract, { description: 'Return the current version of your task contract, your worktree and any active repair contract.' },
    () => asRecipient((taskId) => ok(orchestrator.getContract(taskId))));

  server.registerTool(RECIPIENT_TOOLS.respond_to_contract, {
    description: 'Accept, ask for clarification on, or reject the contract. Accepted responses need interpretation and verification_plan; needs_clarification needs questions.',
    inputSchema: RespondInput,
  }, (args) => asRecipient((taskId) => ok(orchestrator.respond(taskId, args))));

  server.registerTool(RECIPIENT_TOOLS.await_contract, {
    description: 'Long-poll for a contract version newer than since_version (after clarification). Returns pending on timeout; call again.',
    inputSchema: AwaitContractInput,
  }, (args, extra) => asRecipient(async (taskId) => ok(await orchestrator.awaitContract(taskId, args.since_version, args.timeout_s, extra.signal))));

  server.registerTool(RECIPIENT_TOOLS.report_progress, { description: 'Report a progress message (and optional percent).', inputSchema: ReportProgressInput },
    (args) => asRecipient((taskId) => { orchestrator.reportProgress(taskId, args); return ok({ ok: true }); }));

  server.registerTool(RECIPIENT_TOOLS.report_blocker, { description: 'Report that you are blocked, on what, and who you are waiting for.', inputSchema: ReportBlockerInput },
    (args) => asRecipient((taskId) => { orchestrator.reportBlocker(taskId, args); return ok({ ok: true }); }));

  server.registerTool(RECIPIENT_TOOLS.await_reply, {
    description: 'After relay_report_blocker: wait (up to timeout_s) for the human\'s reply. Returns pending on timeout (call again) or none when there is no outstanding blocker.',
    inputSchema: AwaitReplyInput,
  }, (args, extra) => asRecipient(async (taskId) => ok(await orchestrator.awaitReply(taskId, args.timeout_s, extra.signal))));

  // Agent networking (implemented by the agent-net work package; registered here so the tool list is complete).
  server.registerTool(RECIPIENT_TOOLS.propose_subtask, {
    description: 'Delegate a separable unit of your task as a new contract you are the sender of. Linted like any contract; the subtask records you as parent_task.',
    inputSchema: ProposeSubtaskInput,
  }, () => asRecipient(() => fail('relay_propose_subtask is not available yet')));

  server.registerTool(RECIPIENT_TOOLS.await_task, {
    description: 'Wait (up to timeout_s) until another task reaches completed / failed / canceled; returns pending on timeout.',
    inputSchema: AwaitTaskInput,
  }, () => asRecipient(() => fail('relay_await_task is not available yet')));

  server.registerTool(RECIPIENT_TOOLS.submit_evidence, {
    description: 'Submit your claimed status per criterion and a summary. relayd collects the diff and runs every check itself.',
    inputSchema: SubmitEvidenceInput,
  }, (args) => asRecipient((taskId) => ok(orchestrator.submitEvidence(taskId, args))));

  server.registerTool(RECIPIENT_TOOLS.await_verdict, {
    description: 'Long-poll for the verdict of an attempt: verified, a delta repair contract, failed_budget, escalated, or pending (call again).',
    inputSchema: AwaitVerdictInput,
  }, (args, extra) => asRecipient(async (taskId) => ok(await orchestrator.awaitVerdict(taskId, args.attempt, args.timeout_s, extra.signal))));

  // ---- planner tools ----
  server.registerTool(PLANNER_TOOLS.get_mission, { description: 'Return the mission, its status and a summary of its tasks.' },
    () => asPlanner((missionId) => {
      const m = orchestrator.getMission(missionId);
      if (!m) return fail(`mission ${missionId} not found`);
      return ok({ ...m, tasks: orchestrator.listTasks(missionId) });
    }));

  server.registerTool(PLANNER_TOOLS.propose_task, {
    description: 'Propose a task contract. It is linted immediately; lint errors are returned so you can fix and re-propose with the same id.',
    inputSchema: ProposeTaskInput,
  }, (args) => asPlanner(async (missionId) => ok(await orchestrator.proposeTask(missionId, args.contract, 'planner'))));

  server.registerTool(PLANNER_TOOLS.list_tasks, { description: 'List every task of the mission with its task, handoff and runtime state.' },
    () => asPlanner((missionId) => ok({ tasks: orchestrator.listTasks(missionId) })));

  server.registerTool(PLANNER_TOOLS.revise_task, {
    description: 'Patch a contract, producing version n+1 (re-linted; the recipient is asked to respond again).',
    inputSchema: ReviseTaskInput,
  }, (args) => asPlanner(async (missionId) => {
    ownedTask(missionId, args.task_id);
    return ok(await orchestrator.reviseTask(args.task_id, args.patch, 'planner'));
  }));

  server.registerTool(PLANNER_TOOLS.answer_clarification, {
    description: 'Answer a recipient\'s clarification questions on behalf of the human, producing version n+1.',
    inputSchema: AnswerClarificationInput,
  }, (args) => asPlanner(async (missionId) => {
    ownedTask(missionId, args.task_id);
    return ok(await orchestrator.clarify(args.task_id, args.answers, 'planner'));
  }));

  server.registerTool(PLANNER_TOOLS.ask_human, {
    description: 'Ask the human the mission-level questions that must be settled before decomposition (e.g. which mechanism to build). Replaces any still-open questions. Then poll relay_await_answers.',
    inputSchema: AskHumanInput,
  }, (args) => asPlanner((missionId) => ok(orchestrator.askHuman(missionId, args.questions))));

  server.registerTool(PLANNER_TOOLS.await_answers, {
    description: 'Wait (up to timeout_s) until the human has answered every open mission question. Returns pending on timeout: call again.',
    inputSchema: AwaitAnswersInput,
  }, (args, extra) => asPlanner(async (missionId) => ok(await orchestrator.awaitAnswers(missionId, args.timeout_s, extra.signal))));

  return server;
}

/** Mounts the MCP endpoint at `routes.mcp` on the given Hono app. */
export function mountMcp(app: Hono, orchestrator: Orchestrator): void {
  app.all(routes.mcp, async (c) => {
    const token = bearer(c.req.header('authorization'));
    const subject = token ? orchestrator.resolveToken(token) : undefined;
    const server = buildMcpServer(orchestrator, subject, token !== undefined);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}

