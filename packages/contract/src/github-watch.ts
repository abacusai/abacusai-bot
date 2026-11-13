/**
 * How a GitHub watcher event is said, the same in the app's list, its native
 * notice and the chat-app ping: one translated line.
 */
import type { GithubWatchEvent } from "./contract/github";

export type GithubWatchWords = (
  key: string,
  values?: Record<string, string | number>
) => string;

const prLabel = (event: GithubWatchEvent): string =>
  event.number == null
    ? (event.branch ?? event.title)
    : `#${event.number} ${event.title}`;

/** The pull request (`#42 Add login`) or branch an event is about. */
export const githubEventSubject = prLabel;

/** One event in words, without a leading mark. */
export const githubEventText = (
  event: GithubWatchEvent,
  t: GithubWatchWords
): string => {
  const values = {
    pr: prLabel(event),
    repo: event.repo,
    who: event.who.join(", "),
    detail: event.detail,
  };
  switch (event.kind) {
    case "ci":
      return t("githubWatch.line.ci", values);
    case "review":
      return t(
        event.verdict === "changes"
          ? "githubWatch.line.changes"
          : event.verdict === "approved"
            ? "githubWatch.line.approved"
            : "githubWatch.line.review",
        values
      );
    case "pr":
      return t(
        event.waitsOnYou ? "githubWatch.line.prYours" : "githubWatch.line.pr",
        values
      );
  }
};

const MARKS: Record<GithubWatchEvent["kind"], string> = {
  ci: "❌",
  review: "💬",
  pr: "🆕",
};

/** One event as a notice or chat line: a mark, the words, a comment's start, and "while away". */
export const githubEventLine = (
  event: GithubWatchEvent,
  t: GithubWatchWords
): string => {
  let line = `${MARKS[event.kind]} ${githubEventText(event, t)}`;
  if (event.kind === "review" && event.detail.length > 0)
    line += `: “${event.detail}”`;
  return event.whileAway ? `${line} (${t("githubWatch.line.away")})` : line;
};
