/**
 * `narrate(event, state)`: one plain-English sentence per event, present tense, actors named by role
 * (`backend`, `planner`, `you` for the human, `RelayGraph` for relayd). Pure and total: never throws on a
 * valid event, even when the task or mission is unknown to `state`.
 */
import type { Event } from '../events.js';
import type { State } from '../state.js';
import { actorName, clip, plural, repairName, roleOf } from './common.js';

const quote = (text: string): string => `"${clip(text)}"`;

const questionList = (questions: { id: string; text: string }[]): string => questions.map((q) => `${q.id} ${clip(q.text)}`).join('; ');

const list = (items: string[]): string => items.map((i) => clip(i)).join('; ');

/** Role of the task the event concerns: the agent actor's role when it is one, otherwise from state. */
function role(event: Event, state: State): string {
  if (event.actor.startsWith('agent:')) return actorName(event.actor);
  return roleOf(state, event.task_id);
}

const task = (event: Event): string => event.task_id ?? 'the task';

export function narrate(event: Event, state: State): string {
  const who = actorName(event.actor);
  switch (event.type) {
    // --- mission ---------------------------------------------------------------------------------
    case 'mission_created':
      return `${who} create${s(who)} mission ${quote(event.payload.title)} in ${event.payload.repo}`;
    case 'mission_clarification_requested':
      return `${who} ask${s(who)} you ${plural(event.payload.questions.length, 'question')} before decomposing: ${questionList(event.payload.questions)}`;
    case 'mission_clarification_answered':
      return `${who} answer${s(who)} ${plural(event.payload.answers.length, 'mission question')}: ${list(event.payload.answers.map((a) => `${a.question_id} ${a.answer}`))}`;
    case 'tasks_planned':
      return `${who} plan${s(who)} ${plural(event.payload.task_ids.length, 'task')}: ${event.payload.task_ids.join(', ')}`;
    case 'integration_started':
      return `${who} integrate${s(who)} ${event.payload.order.join(', ')} into ${event.payload.branch}`;
    case 'integration_conflict':
      return `${who} hit${s(who)} a merge conflict on ${event.payload.task_id}: ${event.payload.files.join(', ')}`;
    case 'mission_verified':
      return `${who} verif${who === 'you' ? 'y' : 'ies'} the mission: integration check passed`;
    case 'mission_failed':
      return `${who} mark${s(who)} the mission failed: ${clip(event.payload.reason)}`;

    // --- contract --------------------------------------------------------------------------------
    case 'task_proposed': {
      const c = event.payload.contract;
      const paths = c.scope.allowed_paths;
      const scope = paths.length > 0 ? `, paths ${paths.join(', ')}` : '';
      return `${who} propose${s(who)} ${c.id} v${c.version} to ${c.recipient}: ${quote(c.goal)} (${plural(c.acceptance_criteria.length, 'criterion', 'criteria')}${scope})`;
    }
    case 'lint_reported': {
      const errors = event.payload.results.filter((r) => r.severity === 'error');
      const warnings = event.payload.results.filter((r) => r.severity === 'warning');
      const head = `${who} lint${s(who)} ${task(event)} v${event.payload.contract_version}`;
      if (errors.length > 0) return `${head}: ${plural(errors.length, 'error')} — ${list(errors.map((r) => `${r.rule}: ${r.message}`))}`;
      if (warnings.length > 0) return `${head}: ${plural(warnings.length, 'warning')} — ${list(warnings.map((r) => `${r.rule}: ${r.message}`))}`;
      return `${head}: clean`;
    }
    case 'clarification_requested': {
      const qs = event.payload.response.questions;
      return `${role(event, state)} asks ${plural(qs.length, 'question')} before starting: ${questionList(qs)}`;
    }
    case 'clarification_answered':
      return `${who} answer${s(who)} ${plural(event.payload.answers.length, 'question')} for ${role(event, state)}: ${list(event.payload.answers.map((a) => `${a.question_id} ${a.answer}`))}`;
    case 'contract_revised':
      return `${who} revise${s(who)} ${event.payload.contract.id} to v${event.payload.contract.version} (was v${event.payload.previous_version})`;
    case 'task_accepted': {
      const r = event.payload.response;
      const restated = r.interpretation.length > 0 ? ` and restates it: ${list(r.interpretation)}` : '';
      return `${role(event, state)} accepts v${event.payload.contract_version}${restated}`;
    }
    case 'task_rejected': {
      const reason = event.payload.response.reason;
      return `${role(event, state)} rejects v${event.payload.contract_version}${reason ? `: ${clip(reason)}` : ''}`;
    }

    // --- runtime ---------------------------------------------------------------------------------
    case 'worktree_created':
      return `${who} create${s(who)} worktree ${event.payload.branch} at ${event.payload.path}`;
    case 'agent_spawned': {
      const target = event.task_id ? roleOf(state, event.task_id) : 'the planner';
      return `${who} spawn${s(who)} ${target} (${event.payload.runtime}) in pane ${event.payload.pane_id}`;
    }
    case 'agent_exited': {
      const target = event.task_id ? roleOf(state, event.task_id) : 'the planner';
      return `${target} exits${event.payload.exit_reason ? ` (${clip(event.payload.exit_reason)})` : ''}`;
    }
    case 'work_started':
      return `${role(event, state)} starts working on ${task(event)}`;
    case 'progress_reported': {
      const pct = event.payload.percent !== undefined ? ` (${event.payload.percent}%)` : '';
      return `${role(event, state)} reports: ${quote(event.payload.message)}${pct}`;
    }
    case 'task_blocked': {
      const waiting = event.payload.waiting_on ? ` (waiting on ${clip(event.payload.waiting_on)})` : '';
      return `${role(event, state)} is stuck: ${clip(event.payload.reason)}${waiting}`;
    }
    case 'task_unblocked':
      return event.actor.startsWith('agent:') ? `${role(event, state)} resumes work` : `${who} unblock${s(who)} ${roleOf(state, event.task_id)}`;
    case 'blocker_replied':
      return `${who} repl${who === 'you' ? 'y' : 'ies'} to ${roleOf(state, event.task_id)}: ${quote(event.payload.message)}`;

    // --- evidence --------------------------------------------------------------------------------
    case 'evidence_submitted': {
      const sub = event.payload.submission;
      const counts = tally(Object.values(sub.claimed).map((c) => c.status));
      const summary = sub.summary ? `: ${quote(sub.summary)}` : '';
      return `${role(event, state)} submits evidence #${sub.attempt} claiming ${counts}${summary}`;
    }
    case 'checks_started':
      return `${who} start${s(who)} checks on ${roleOf(state, event.task_id)}'s attempt ${event.payload.attempt}`;
    case 'check_passed':
      return `${who} run${s(who)} ${event.payload.criterion_id}: passed`;
    case 'check_failed': {
      const observed = event.payload.result.observed;
      return `${who} run${s(who)} ${event.payload.criterion_id}: ${event.payload.result.status}${observed ? ` — ${clip(observed)}` : ''}`;
    }
    case 'human_review_recorded': {
      const observed = event.payload.observed_failure;
      return `${who} mark${s(who)} ${event.payload.criterion_id} ${event.payload.status}${observed ? ` — ${clip(observed)}` : ''}`;
    }
    case 'evidence_recorded': {
      const rec = event.payload.record;
      const counts = tally(Object.values(rec.checks).map((c) => c.status));
      const mismatch = rec.self_report_mismatch.length > 0 ? ` (self-report mismatch on ${rec.self_report_mismatch.join(', ')})` : '';
      return `${who} record${s(who)} attempt ${rec.attempt}: ${counts}${mismatch}`;
    }
    case 'repair_requested': {
      const r = event.payload.repair;
      return `${who} open${s(who)} repair ${repairName(r.id)} for ${r.failed_criteria.join(', ')} only (${plural(r.remaining_repairs, 'repair')} left)`;
    }
    case 'repair_accepted':
      return `${role(event, state)} accepts repair ${repairName(event.payload.repair_id)}`;
    case 'task_verified':
      return `${who} verif${who === 'you' ? 'y' : 'ies'} ${roleOf(state, event.task_id)}: every criterion of attempt ${event.payload.attempt} passed`;
    case 'task_completed':
      return `${roleOf(state, event.task_id)} completes ${task(event)}`;
    case 'task_failed_budget':
      return `${who} stop${s(who)} ${task(event)} after ${plural(event.payload.attempts, 'attempt')}: ${clip(event.payload.reason)}`;
    case 'task_escalated':
      return `${who} escalate${s(who)} ${task(event)} to you: ${clip(event.payload.reason)} (${event.payload.failed_criteria.join(', ')})`;
    case 'task_canceled':
      return `${who} cancel${s(who)} ${task(event)}${event.payload.reason ? `: ${clip(event.payload.reason)}` : ''}`;

    default:
      return `${who} ${humanize((event as Event).type)}${(event as Event).task_id ? ` on ${(event as Event).task_id}` : ''}`;
  }
}

/** Third-person `s` for every actor except `you`. */
const s = (who: string): string => (who === 'you' ? '' : 's');

/** `2 passed, 1 failed, 1 pending review` from a list of statuses, skipping zero counts. */
function tally(statuses: string[]): string {
  const order: Array<[string, string]> = [['passed', 'passed'], ['failed', 'failed'], ['skipped', 'skipped'], ['pending_human', 'pending review'], ['error', 'errored']];
  const counts = new Map<string, number>();
  for (const st of statuses) counts.set(st, (counts.get(st) ?? 0) + 1);
  const parts = order.filter(([k]) => counts.has(k)).map(([k, label]) => `${counts.get(k)} ${label}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

/** Fallback wording for a type this module does not know (only reachable if the event union grows). */
const humanize = (type: string): string => type.replace(/_/g, ' ');
