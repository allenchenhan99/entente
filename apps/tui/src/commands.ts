import { CancelBody, ClarifyBody, ReviewBody, routes } from '@relay/protocol';

import type { CommandExecutor, FetchLike } from './context.js';

function commandUrl(baseUrl: string, route: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${route}`;
}

async function postJson(fetcher: FetchLike, url: string, body: unknown): Promise<void> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}`.trim());
}

export async function postClarification(options: {
  fetch: FetchLike;
  url: string;
  taskId: string;
  questionId: string;
  answer: string;
}): Promise<void> {
  const body = ClarifyBody.parse({ answers: [{ question_id: options.questionId, answer: options.answer }] });
  await postJson(options.fetch, commandUrl(options.url, routes.clarify(options.taskId)), body);
}

export async function postReview(options: {
  fetch: FetchLike;
  url: string;
  taskId: string;
  criterionId: string;
  status: 'passed' | 'failed';
  observedFailure?: string;
}): Promise<void> {
  const body = ReviewBody.parse({
    criterion_id: options.criterionId,
    status: options.status,
    ...(options.observedFailure === undefined ? {} : { observed_failure: options.observedFailure }),
  });
  await postJson(options.fetch, commandUrl(options.url, routes.review(options.taskId)), body);
}

export async function postCancel(options: { fetch: FetchLike; url: string; taskId: string }): Promise<void> {
  await postJson(options.fetch, commandUrl(options.url, routes.cancel(options.taskId)), CancelBody.parse({}));
}

export type FocusCommand = 'herdr' | 'tmux' | 'none';

export function focusArgv(command: FocusCommand, paneId: string): string[] | undefined {
  if (command === 'herdr') return ['herdr', 'agent', 'focus', paneId];
  if (command === 'tmux') return ['tmux', 'select-pane', '-t', paneId];
  return undefined;
}

export async function focusPane(execute: CommandExecutor, command: FocusCommand, paneId: string): Promise<void> {
  const argv = focusArgv(command, paneId);
  if (argv) await execute(argv);
}
