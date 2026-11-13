/**
 * The GitHub watcher: while the app runs it reads the repos the user picked
 * once a minute and tells them, with no model call, only when their code
 * needs them: a new pull request (someone else's), a new review or comment
 * on one of theirs, or a failed GitHub Actions run on their PR's branch, a
 * run they started, or the default branch. A Fix it then starts a session.
 *
 * Cheap by construction: each repo costs two conditional requests a check
 * (the open PRs and the latest runs, sent with the last ETag, so an
 * unchanged answer is a 304 that GitHub does not count against the rate
 * limit), plus three for each of the user's PRs that changed. The first
 * check of a repo only records what is there, so turning it on never floods.
 */
import fs from "node:fs";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import { appNoteTag } from "@abacus-ai/agent/user-text";
import type {
  GithubWatchConfig,
  GithubWatchEvent,
  GithubWatchEventKind,
} from "@abacus-ai/contract/contract/github";
import {
  githubEventLine,
  githubEventSubject,
  type GithubWatchWords,
} from "@abacus-ai/contract/github-watch";

export const GITHUB_WATCH_EVERY_MS = 60_000;
/** Something older than this when first seen is history, not news. */
export const GITHUB_WATCH_NEWS_MS = 24 * 60 * 60_000;
/** A gap between checks longer than this means the app was closed or asleep. */
const AWAY_GAP_MS = 10 * 60_000;
const EVENTS_KEPT = 30;
const SEEN_KEPT = 300;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BRANCH_EVERY_MS = 6 * 60 * 60_000;
const DETAIL_CHARS = 140;
const API = "https://api.github.com";
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** What a check reads of one open pull request. */
export interface WatchPr {
  number: number;
  title: string;
  author: string;
  head: string;
  draft: boolean;
  updatedAt: string;
  createdAt: string;
  url: string;
  reviewers: string[];
}

/** What a check reads of one workflow run. */
export interface WatchRun {
  id: number;
  attempt: number;
  name: string;
  branch: string | null;
  sha: string;
  workflowId: number;
  status: string;
  conclusion: string | null;
  actor: string | null;
  createdAt: string;
  url: string;
}

/** A review, review comment or conversation comment on one of the user's PRs. */
export interface WatchNote {
  author: string;
  bot: boolean;
  /** "comment", or a review's verdict. */
  kind: string;
  body: string;
  at: string;
  /** A conversation comment (not part of a review). */
  conversation: boolean;
}

/** What the watcher keeps of a repo between checks. */
export interface RepoMemory {
  /** Open PRs by number, as last read. */
  prs: Record<string, { updatedAt: string; author: string }>;
  /** PRs already told (or already there at the first read). */
  seenPrs: number[];
  /** Per PR of the user's: the newest review or comment already counted. */
  notesSince: Record<string, string>;
  /** Runs already told, as `id:attempt`. */
  seenRuns: string[];
  defaultBranch: string | null;
  defaultBranchAt: number;
}

export const emptyRepoMemory = (): RepoMemory => ({
  prs: {},
  seenPrs: [],
  notesSince: {},
  seenRuns: [],
  defaultBranch: null,
  defaultBranchAt: 0,
});

/** One event before it is placed in a project and given its prompt. */
export type FoundEvent = Omit<
  GithubWatchEvent,
  "workspaceId" | "prompt" | "fix" | "whileAway"
> & { runIds: number[] };

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= DETAIL_CHARS
    ? flat
    : `${flat.slice(0, DETAIL_CHARS - 1).trimEnd()}…`;
};

const capped = <T>(list: T[]): T[] => list.slice(-SEEN_KEPT);

const fresh = (at: string, now: number): boolean =>
  now - Date.parse(at) <= GITHUB_WATCH_NEWS_MS;

/**
 * New pull requests by others. On the first read (`seeding`) every open PR is
 * recorded and none is told.
 */
export const findNewPrs = (
  repo: string,
  memory: RepoMemory,
  prs: readonly WatchPr[],
  me: string,
  now: number,
  seeding: boolean
): FoundEvent[] => {
  const events: FoundEvent[] = [];
  const seen = new Set(memory.seenPrs);
  for (const pr of prs) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    if (seeding || pr.draft || sameLogin(pr.author, me)) continue;
    if (!fresh(pr.createdAt, now)) continue;
    const waitsOnYou = pr.reviewers.some((login) => sameLogin(login, me));
    events.push({
      id: `pr:${repo}#${pr.number}`,
      kind: "pr",
      repo,
      number: pr.number,
      title: pr.title,
      branch: pr.head,
      url: pr.url,
      who: [pr.author],
      detail: "",
      verdict: null,
      waitsOnYou,
      at: pr.createdAt,
      runIds: [],
    });
  }
  memory.seenPrs = capped([...seen]);
  return events;
};

/** The user's open PRs whose `updatedAt` moved since the last read: the ones worth asking for notes. */
export const changedOwnPrs = (
  memory: RepoMemory,
  prs: readonly WatchPr[],
  me: string
): WatchPr[] =>
  prs.filter(
    (pr) =>
      sameLogin(pr.author, me) &&
      memory.prs[String(pr.number)]?.updatedAt !== pr.updatedAt
  );

/**
 * The reviews and comments on one of the user's PRs since the last counted
 * one, as one event. Their own words and a bot's conversation comments (a
 * deploy preview) are not news; a review bot's review is. The first read of
 * a PR only sets the mark.
 */
export const findNotes = (
  repo: string,
  memory: RepoMemory,
  pr: WatchPr,
  notes: readonly WatchNote[],
  me: string,
  now: number
): FoundEvent | null => {
  const key = String(pr.number);
  const since = memory.notesSince[key];
  const newest = notes.reduce(
    (latest, note) => (note.at > latest ? note.at : latest),
    since ?? ""
  );
  memory.notesSince[key] = newest.length > 0 ? newest : isoSeconds(now);
  if (since == null) return null;
  const news = notes
    .filter(
      (note) =>
        note.at > since &&
        !sameLogin(note.author, me) &&
        !(note.bot && note.conversation) &&
        // An empty "commented" review is the wrapper of its line comments.
        !(note.kind === "COMMENTED" && note.body.trim().length === 0)
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  if (news.length === 0) return null;
  const verdict =
    news.find((note) => note.kind === "CHANGES_REQUESTED") ??
    news.find((note) => note.kind === "APPROVED");
  const worded = news.find((note) => note.body.trim().length > 0);
  const latest = news[news.length - 1]!;
  return {
    id: `review:${repo}#${pr.number}@${latest.at}`,
    kind: "review",
    repo,
    number: pr.number,
    title: pr.title,
    branch: pr.head,
    url: pr.url,
    who: [...new Set(news.map((note) => note.author))],
    detail: worded != null ? excerpt(worded.body) : "",
    verdict:
      verdict?.kind === "CHANGES_REQUESTED"
        ? "changes"
        : verdict?.kind === "APPROVED"
          ? "approved"
          : null,
    waitsOnYou: false,
    at: latest.at,
    runIds: [],
  };
};

/**
 * Failed runs that concern the user, one event per commit: on one of their
 * PRs' branches, started by them, or on the default branch. A run whose
 * workflow already passed again on that branch is fixed, not news.
 */
export const findFailedRuns = (
  repo: string,
  memory: RepoMemory,
  runs: readonly WatchRun[],
  prs: readonly WatchPr[],
  me: string,
  now: number,
  seeding: boolean
): FoundEvent[] => {
  const seen = new Set(memory.seenRuns);
  const ownHeads = new Map(
    prs.filter((pr) => sameLogin(pr.author, me)).map((pr) => [pr.head, pr])
  );
  const anyHead = new Map(prs.map((pr) => [pr.head, pr]));
  const bySha = new Map<string, WatchRun[]>();
  for (const run of runs) {
    if (run.status !== "completed" || run.conclusion == null) continue;
    if (!FAILED.has(run.conclusion)) continue;
    const key = `${run.id}:${run.attempt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seeding || !fresh(run.createdAt, now)) continue;
    const mine =
      (run.actor != null && sameLogin(run.actor, me)) ||
      (run.branch != null && ownHeads.has(run.branch)) ||
      (run.branch != null && run.branch === memory.defaultBranch);
    if (!mine) continue;
    const passedSince = runs.some(
      (other) =>
        other.workflowId === run.workflowId &&
        other.branch === run.branch &&
        other.conclusion === "success" &&
        other.createdAt > run.createdAt
    );
    if (passedSince) continue;
    bySha.set(run.sha, [...(bySha.get(run.sha) ?? []), run]);
  }
  memory.seenRuns = capped([...seen]);
  return [...bySha.entries()].map(([sha, failed]) => {
    const first = failed[0]!;
    const pr = first.branch == null ? undefined : anyHead.get(first.branch);
    return {
      id: `ci:${repo}@${sha}:${failed.map((run) => `${run.id}.${run.attempt}`).join(",")}`,
      kind: "ci" as const,
      repo,
      number: pr?.number ?? null,
      title: pr?.title ?? first.branch ?? sha.slice(0, 7),
      branch: first.branch,
      url: first.url,
      who: [
        ...new Set(
          failed.flatMap((run) => (run.actor == null ? [] : [run.actor]))
        ),
      ],
      detail: [...new Set(failed.map((run) => run.name))].join(", "),
      verdict: null,
      waitsOnYou: false,
      at: failed.reduce(
        (latest, run) => (run.createdAt > latest ? run.createdAt : latest),
        first.createdAt
      ),
      runIds: failed.map((run) => run.id),
    };
  });
};

/** GitHub's own form (no milliseconds), so marks compare as strings. */
const isoSeconds = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const sameLogin = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** The task a Fix it starts with: for the agent, in English like every prompt. */
export const githubFixPrompt = (event: FoundEvent): string => {
  const pr =
    event.number == null
      ? `branch ${event.branch ?? "(unknown)"}`
      : `pull request #${event.number} "${event.title}" (branch ${event.branch ?? "unknown"})`;
  const worktree = [
    "Work in a separate git worktree of that branch (git fetch, then git worktree add), so the checkout",
    "and any uncommitted work in this folder stay untouched; remove the worktree when you are done.",
  ].join(" ");
  switch (event.kind) {
    case "ci":
      return [
        `GitHub Actions failed on ${pr} in ${event.repo}: ${event.detail}.`,
        `Read the failed jobs' logs with \`gh run view <run id> --log-failed\` (run ids: ${event.runIds.join(", ")}),`,
        "find the cause and fix it. Run the failing tests or checks locally until they pass, then commit and push",
        `to ${event.branch ?? "the branch"}. ${worktree} If the failure is not in the code (a flaky test, an expired`,
        "secret, an outage), change nothing and say so. End with two lines: what broke and what you changed.",
      ].join(" ");
    case "review":
      return [
        `New review comments on ${pr} in ${event.repo} from ${event.who.join(", ")}.`,
        `Read them with \`gh pr view ${event.number} --comments\` and`,
        `\`gh api repos/${event.repo}/pulls/${event.number}/comments\`. Make the changes they ask for where the ask`,
        "is clear, run the tests, then commit and push to the branch. Do not reply on GitHub. Where a comment is a",
        `question or you disagree, leave the code as is and tell me. ${worktree} End with a short list: each comment`,
        "and what you did about it.",
      ].join(" ");
    case "pr":
      return [
        `Review ${pr} in ${event.repo} by ${event.who.join(", ")}. Read it with \`gh pr view ${event.number}\` and`,
        `\`gh pr diff ${event.number}\`. Tell me what it changes, whether it is safe to merge, and any bugs or risks`,
        "with the file and line. Do not approve, comment or push anything on GitHub.",
      ].join(" ");
  }
};

/** The kind of a found event, for the funnel. */
export const eventKind = (event: { kind: GithubWatchEventKind }): string =>
  event.kind;

/* ----------------------------------------------------------------- words */

/** The local calendar day of `ms`, for the daily ping allowance. */
export const localDay = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** At most this many phone pings a day; the app still lists the rest. */
export const GITHUB_WATCH_PINGS_PER_DAY = 10;
const PING_EVENTS_SHOWN = 3;
const NOTE_KEPT_MS = 24 * 60 * 60_000;
const NOTES_KEPT = 3;

/** Whether the events ask for a review rather than a fix. */
const onlyNewPrs = (events: readonly GithubWatchEvent[]): boolean =>
  events.every((event) => event.kind === "pr");

/** One check's events as one chat-app message, ending on what a reply does. */
export const githubPingText = (
  events: readonly GithubWatchEvent[],
  t: GithubWatchWords,
  canFix: boolean
): string => {
  const shown = events.slice(0, PING_EVENTS_SHOWN);
  const parts = shown.map(
    (event) => `${githubEventLine(event, t)}\n${event.url}`
  );
  if (events.length > shown.length)
    parts.push(
      t("githubWatch.ping.more", { count: events.length - shown.length })
    );
  parts.push(
    canFix
      ? t(
          onlyNewPrs(events)
            ? "githubWatch.ping.replyReview"
            : "githubWatch.ping.replyFix"
        )
      : t("githubWatch.ping.openApp")
  );
  return parts.join("\n\n");
};

/** What a fix asked for from the phone sends back when it ends. */
export const githubFixDoneText = (
  event: GithubWatchEvent,
  outcome: "completed" | "failed" | "timeout" | "not-started",
  answer: string,
  t: GithubWatchWords
): string => {
  const head =
    outcome === "completed"
      ? t(
          event.kind === "pr"
            ? "githubWatch.fix.reviewed"
            : "githubWatch.fix.done",
          { pr: githubEventSubject(event) }
        )
      : t("githubWatch.fix.failed", { pr: githubEventSubject(event) });
  const body = answer.trim();
  return body.length > 0 && outcome === "completed"
    ? `${head}\n\n${body.length > 1_200 ? `${body.slice(0, 1_199).trimEnd()}…` : body}`
    : head;
};

/** Report text cannot close or open the note's hidden block. */
const neutralized = (text: string): string =>
  text.replace(/<(\/?)system_reminder/gi, "<$1system-reminder");

/**
 * The hidden note the user's chat with their home bot hears on their next
 * message there: what the ping said, and the one tool that acts on it.
 */
export const githubPingNote = (
  events: readonly GithubWatchEvent[],
  lanes: readonly string[],
  t: GithubWatchWords
): string =>
  `${appNoteTag("github watch")} The app sent the user this about their GitHub repos on ${lanes.join(" and ")}:\n` +
  events
    .map(
      (event) =>
        `- event_id ${event.id}: ${neutralized(JSON.stringify(githubEventLine(event, t)))} (${event.kind} on ${event.repo})`
    )
    .join("\n") +
  '\nIf their message asks to fix or review one of these ("fix", "go", "yes", "review it"), call github_fix with its' +
  " event_id (the first one when they do not say which) and tell them in one short line, in their language, that it" +
  " has started on their computer and the result will come here. Do not do the work in this chat. If their message is" +
  " about something else, ignore this note.";

/* ---------------------------------------------------------------- GitHub */

type FetchLike = typeof fetch;

/** GitHub said to wait until this time (ms). */
export class GithubRateLimited extends Error {
  constructor(readonly until: number) {
    super("GitHub rate limit");
  }
}

/** The token was refused. */
export class GithubUnauthorized extends Error {}

/**
 * REST with ETags: an unchanged answer is a 304 served from the last body,
 * free against the rate limit. Bodies are kept in memory only.
 */
export class GithubRest {
  private readonly cache = new Map<string, { etag: string; body: unknown }>();

  constructor(
    private readonly token: () => string,
    private readonly doFetch: FetchLike = fetch
  ) {}

  /** Forget cached answers (a new token may see other things). */
  reset(): void {
    this.cache.clear();
  }

  async get<T>(path: string): Promise<T | null> {
    const cached = this.cache.get(path);
    const response = await this.doFetch(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "abacusai-bot",
        ...(cached != null ? { "If-None-Match": cached.etag } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 304 && cached != null) return cached.body as T;
    if (response.status === 401)
      throw new GithubUnauthorized("GitHub refused the token");
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new GithubRateLimited(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Date.now() + retryAfter * 1000
          : Number.isFinite(reset) && reset > 0
            ? reset * 1000
            : Date.now() + 15 * 60_000
      );
    }
    // Gone, or this token cannot see it: nothing to tell.
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const body = (await response.json()) as T;
    const etag = response.headers.get("etag");
    if (etag != null) this.cache.set(path, { etag, body });
    return body;
  }
}

interface ApiUser {
  login?: string;
  type?: string;
}

const login = (user: ApiUser | null | undefined): string => user?.login ?? "";
const isBot = (user: ApiUser | null | undefined): boolean =>
  user?.type === "Bot" || login(user).endsWith("[bot]");

/** The open PRs, newest activity first (one page: the 50 most recently updated). */
export const readPrs = async (
  api: GithubRest,
  repo: string
): Promise<WatchPr[] | null> => {
  const rows = await api.get<
    Array<{
      number: number;
      title: string;
      user: ApiUser | null;
      head: { ref: string };
      draft?: boolean;
      updated_at: string;
      created_at: string;
      html_url: string;
      requested_reviewers?: ApiUser[];
    }>
  >(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=50`);
  return (
    rows?.map((row) => ({
      number: row.number,
      title: row.title,
      author: login(row.user),
      head: row.head.ref,
      draft: row.draft === true,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      url: row.html_url,
      reviewers: (row.requested_reviewers ?? []).map(login),
    })) ?? null
  );
};

export const readRuns = async (
  api: GithubRest,
  repo: string
): Promise<WatchRun[] | null> => {
  const body = await api.get<{
    workflow_runs?: Array<{
      id: number;
      run_attempt?: number;
      name?: string | null;
      head_branch: string | null;
      head_sha: string;
      workflow_id: number;
      status: string | null;
      conclusion: string | null;
      actor?: ApiUser | null;
      triggering_actor?: ApiUser | null;
      created_at: string;
      html_url: string;
    }>;
  }>(`/repos/${repo}/actions/runs?per_page=30`);
  return (
    body?.workflow_runs?.map((run) => ({
      id: run.id,
      attempt: run.run_attempt ?? 1,
      name: run.name ?? "workflow",
      branch: run.head_branch,
      sha: run.head_sha,
      workflowId: run.workflow_id,
      status: run.status ?? "",
      conclusion: run.conclusion,
      actor: login(run.triggering_actor ?? run.actor) || null,
      createdAt: run.created_at,
      url: run.html_url,
    })) ?? null
  );
};

/** Reviews, line comments and conversation comments of one PR. */
export const readNotes = async (
  api: GithubRest,
  repo: string,
  number: number,
  since: string | null
): Promise<WatchNote[]> => {
  const query = since == null ? "" : `&since=${encodeURIComponent(since)}`;
  const [reviews, lines, conversation] = await Promise.all([
    api.get<
      Array<{
        user: ApiUser | null;
        state: string;
        body: string | null;
        submitted_at?: string | null;
      }>
    >(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    api.get<Array<{ user: ApiUser | null; body: string; created_at: string }>>(
      `/repos/${repo}/pulls/${number}/comments?per_page=100${query}`
    ),
    api.get<
      Array<{ user: ApiUser | null; body: string | null; created_at: string }>
    >(`/repos/${repo}/issues/${number}/comments?per_page=100${query}`),
  ]);
  return [
    ...(reviews ?? []).flatMap((review) =>
      review.submitted_at == null || review.state === "PENDING"
        ? []
        : [
            {
              author: login(review.user),
              bot: isBot(review.user),
              kind: review.state,
              body: review.body ?? "",
              at: review.submitted_at,
              conversation: false,
            },
          ]
    ),
    ...(lines ?? []).map((comment) => ({
      author: login(comment.user),
      bot: isBot(comment.user),
      kind: "comment",
      body: comment.body,
      at: comment.created_at,
      conversation: false,
    })),
    ...(conversation ?? []).map((comment) => ({
      author: login(comment.user),
      bot: isBot(comment.user),
      kind: "comment",
      body: comment.body ?? "",
      at: comment.created_at,
      conversation: true,
    })),
  ];
};

/** Everything one check of one repo found; `memory` is updated in place. */
export const checkRepo = async (
  api: GithubRest,
  repo: string,
  memory: RepoMemory,
  me: string,
  now: number,
  seeding: boolean
): Promise<FoundEvent[]> => {
  if (now - memory.defaultBranchAt > DEFAULT_BRANCH_EVERY_MS) {
    const info = await api.get<{ default_branch?: string }>(`/repos/${repo}`);
    memory.defaultBranch = info?.default_branch ?? memory.defaultBranch;
    memory.defaultBranchAt = now;
  }
  const [prs, runs] = await Promise.all([
    readPrs(api, repo),
    readRuns(api, repo),
  ]);
  if (prs == null) return [];
  const events = findNewPrs(repo, memory, prs, me, now, seeding);
  for (const pr of changedOwnPrs(memory, prs, me)) {
    const since = memory.notesSince[String(pr.number)] ?? null;
    // A PR first seen now only sets its mark: no need to read its history.
    if (since == null) {
      findNotes(repo, memory, pr, [], me, now);
      continue;
    }
    const found = findNotes(
      repo,
      memory,
      pr,
      await readNotes(api, repo, pr.number, since),
      me,
      now
    );
    if (found != null && !seeding) events.push(found);
  }
  if (runs != null)
    events.push(...findFailedRuns(repo, memory, runs, prs, me, now, seeding));
  memory.prs = Object.fromEntries(
    prs.map((pr) => [
      String(pr.number),
      { updatedAt: pr.updatedAt, author: pr.author },
    ])
  );
  // Marks of PRs no longer open go with them.
  for (const key of Object.keys(memory.notesSince))
    if (memory.prs[key] == null) delete memory.notesSince[key];
  return events;
};

/* ----------------------------------------------------------------- store */

interface Stored {
  config: GithubWatchConfig;
  repos: Record<string, RepoMemory>;
  events: GithubWatchEvent[];
  lastCheckAt: number | null;
  /** Phone pings per day (`YYYY-MM-DD` → count), for the daily cap. */
  pings: Record<string, number>;
  /** Notes owed to a chat's next user message, by session. */
  notes: Record<string, Array<{ text: string; at: number }>>;
}

const OFF: GithubWatchConfig = { on: false, repos: [], phoneFix: false };

export class GithubWatchStore {
  private stored: Stored | null = null;

  constructor(private readonly file: () => string | null) {}

  private get state(): Stored {
    if (this.stored != null) return this.stored;
    this.stored = {
      config: { ...OFF },
      repos: {},
      events: [],
      lastCheckAt: null,
      pings: {},
      notes: {},
    };
    const file = this.file();
    if (file == null) return this.stored;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(file, "utf8")
      ) as Partial<Stored>;
      if (parsed.config != null)
        this.stored.config = { ...OFF, ...parsed.config };
      if (parsed.repos != null) this.stored.repos = parsed.repos;
      if (Array.isArray(parsed.events)) this.stored.events = parsed.events;
      if (typeof parsed.lastCheckAt === "number")
        this.stored.lastCheckAt = parsed.lastCheckAt;
      if (parsed.pings != null) this.stored.pings = parsed.pings;
      if (parsed.notes != null) this.stored.notes = parsed.notes;
    } catch {
      // Never turned on.
    }
    return this.stored;
  }

  save(): void {
    const file = this.file();
    if (file == null) return;
    try {
      writeFileAtomicSync(file, JSON.stringify(this.state));
    } catch (error) {
      console.error("[github-watch] could not save:", error);
    }
  }

  config(): GithubWatchConfig {
    return this.state.config;
  }

  /** New settings; a repo no longer watched forgets what it read. */
  setConfig(config: GithubWatchConfig): void {
    this.state.config = config;
    for (const repo of Object.keys(this.state.repos))
      if (!config.repos.includes(repo)) delete this.state.repos[repo];
    if (!config.on) this.state.lastCheckAt = null;
    this.save();
  }

  /** The repo's memory, and whether this is its first read. */
  memory(repo: string): { memory: RepoMemory; seeding: boolean } {
    const existing = this.state.repos[repo];
    if (existing != null) return { memory: existing, seeding: false };
    const created = emptyRepoMemory();
    this.state.repos[repo] = created;
    return { memory: created, seeding: true };
  }

  /** Forget a repo's memory so its next read is a first one (a check that failed partway). */
  forget(repo: string): void {
    delete this.state.repos[repo];
  }

  lastCheckAt(): number | null {
    return this.state.lastCheckAt;
  }

  setLastCheckAt(at: number): void {
    this.state.lastCheckAt = at;
  }

  events(): GithubWatchEvent[] {
    return this.state.events;
  }

  event(id: string): GithubWatchEvent | null {
    return this.state.events.find((event) => event.id === id) ?? null;
  }

  addEvents(events: GithubWatchEvent[]): void {
    const ids = new Set(events.map((event) => event.id));
    this.state.events = [
      ...events,
      ...this.state.events.filter((event) => !ids.has(event.id)),
    ].slice(0, EVENTS_KEPT);
    this.save();
  }

  setFix(id: string, fix: GithubWatchEvent["fix"]): void {
    const event = this.event(id);
    if (event == null) return;
    event.fix = fix;
    this.save();
  }

  /** Owe `sessionId` a note on its next user message; only the newest few and the last day's count. */
  addNote(sessionId: string, text: string, now: number): void {
    this.state.notes[sessionId] = [
      ...(this.state.notes[sessionId] ?? []).filter(
        (note) => now - note.at <= NOTE_KEPT_MS
      ),
      { text, at: now },
    ].slice(-NOTES_KEPT);
    this.save();
  }

  /** The notes owed to `sessionId`, and `taken` to call once the message went to the agent. */
  notesFor(
    sessionId: string,
    now: number
  ): { notes: string[]; taken: () => void } {
    const owed = (this.state.notes[sessionId] ?? []).filter(
      (note) => now - note.at <= NOTE_KEPT_MS
    );
    return {
      notes: owed.map((note) => note.text),
      taken: () => {
        if (owed.length === 0 && this.state.notes[sessionId] == null) return;
        const left = (this.state.notes[sessionId] ?? []).filter(
          (note) => !owed.includes(note) && now - note.at <= NOTE_KEPT_MS
        );
        if (left.length > 0) this.state.notes[sessionId] = left;
        else delete this.state.notes[sessionId];
        this.save();
      },
    };
  }

  /** Take one ping from today's allowance; false when it is spent. */
  takePing(day: string, cap: number): boolean {
    const used = this.state.pings[day] ?? 0;
    if (used >= cap) return false;
    // Only today's count matters.
    this.state.pings = { [day]: used + 1 };
    this.save();
    return true;
  }
}

/* --------------------------------------------------------------- watcher */

export interface GithubWatchDeps {
  store: GithubWatchStore;
  /** The token to read with: the connector's, a stored one, else `gh`'s; null when none. */
  token: () => Promise<string | null>;
  /** Whether the user allows GitHub at all (the GitHub integration pref). */
  allowed: () => boolean;
  /** The project on this computer for a repo, or null. */
  workspaceFor: (repo: string) => Promise<string | null>;
  /** Events this check found, after they are stored. */
  found: (events: GithubWatchEvent[]) => void;
  doFetch?: FetchLike;
  now?: () => number;
}

export type GithubWatchProblem =
  | "no-token"
  | "disabled"
  | "rate-limited"
  | null;

export class GithubWatch {
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;
  private token: string | null = null;
  private me: string | null = null;
  private waitUntil = 0;
  private problemNow: GithubWatchProblem = null;
  private checkedAt: number | null = null;
  private readonly api: GithubRest;

  constructor(private readonly deps: GithubWatchDeps) {
    this.api = new GithubRest(() => this.token ?? "", deps.doFetch ?? fetch);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => void this.check(), GITHUB_WATCH_EVERY_MS);
    this.timer.unref?.();
    void this.check();
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  problem(): GithubWatchProblem {
    return this.problemNow;
  }

  lastCheckedAt(): number | null {
    return this.checkedAt;
  }

  /** One check now, or the one already under way. */
  check(): Promise<void> {
    this.checking ??= this.checkOnce().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    const config = this.deps.store.config();
    if (!config.on || config.repos.length === 0) return;
    if (!this.deps.allowed()) {
      this.problemNow = "disabled";
      return;
    }
    const now = this.now();
    if (now < this.waitUntil) return;
    const token = await this.deps.token();
    if (token == null) {
      this.problemNow = "no-token";
      return;
    }
    if (token !== this.token) {
      this.token = token;
      this.me = null;
      this.api.reset();
    }
    try {
      this.me ??= login(await this.api.get<ApiUser>("/user")) || null;
      const me = this.me;
      if (me == null) {
        this.problemNow = "no-token";
        return;
      }
      // A long gap since the last check (the app closed, the computer
      // asleep): what happened in it, the last minute aside, was while away.
      const previous = this.deps.store.lastCheckAt();
      const away =
        previous != null && now - previous > AWAY_GAP_MS
          ? { from: previous, to: now - GITHUB_WATCH_EVERY_MS }
          : null;
      const found: Array<FoundEvent & { whileAway: boolean }> = [];
      for (const repo of config.repos) {
        const { memory, seeding } = this.deps.store.memory(repo);
        try {
          const events = await checkRepo(
            this.api,
            repo,
            memory,
            me,
            now,
            seeding
          );
          found.push(
            ...events.map((event) => ({
              ...event,
              whileAway:
                away != null &&
                Date.parse(event.at) > away.from &&
                Date.parse(event.at) < away.to,
            }))
          );
        } catch (error) {
          // A first read cut short is read again from scratch.
          if (seeding) this.deps.store.forget(repo);
          throw error;
        }
      }
      this.problemNow = null;
      this.checkedAt = now;
      this.deps.store.setLastCheckAt(now);
      const events: GithubWatchEvent[] = [];
      for (const { runIds: _runIds, ...event } of found)
        events.push({
          ...event,
          workspaceId: await this.deps.workspaceFor(event.repo),
          prompt: githubFixPrompt({ ...event, runIds: _runIds }),
          fix: { state: "none", sessionId: null },
        });
      if (events.length > 0) this.deps.store.addEvents(events);
      else this.deps.store.save();
      if (events.length > 0) this.deps.found(events);
    } catch (error) {
      if (error instanceof GithubRateLimited) {
        this.waitUntil = error.until;
        this.problemNow = "rate-limited";
      } else if (error instanceof GithubUnauthorized) {
        // Asked again next check: the connector may have a new one by then.
        this.token = null;
        this.problemNow = "no-token";
      } else {
        console.warn(
          "[github-watch] check failed:",
          error instanceof Error ? error.message : error
        );
      }
      this.deps.store.save();
    }
  }
}
