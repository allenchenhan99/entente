import { CancelBody, ClarifyBody, ReplyBody, ReviewBody, routes } from '@relay/protocol';

import type { FetchLike } from './context.js';

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

export async function postMissionClarification(options: {
  fetch: FetchLike;
  url: string;
  missionId: string;
  questionId: string;
  answer: string;
}): Promise<void> {
  const body = ClarifyBody.parse({ answers: [{ question_id: options.questionId, answer: options.answer }] });
  await postJson(options.fetch, commandUrl(options.url, routes.missionClarify(options.missionId)), body);
}

export async function postReply(options: {
  fetch: FetchLike;
  url: string;
  taskId: string;
  message: string;
}): Promise<void> {
  const body = ReplyBody.parse({ message: options.message });
  await postJson(options.fetch, commandUrl(options.url, routes.reply(options.taskId)), body);
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

/** `relay` = ask relayd to focus the pane (`POST /panes/:id/focus`, honoured by relay-tui and the web app); `none` = never. */
export type FocusCommand = 'relay' | 'none';

export async function focusPane(options: { fetch: FetchLike; url: string; command: FocusCommand; paneId: string }): Promise<void> {
  if (options.command === 'none') return;
  await postJson(options.fetch, commandUrl(options.url, `/panes/${options.paneId}/focus`), {});
}
