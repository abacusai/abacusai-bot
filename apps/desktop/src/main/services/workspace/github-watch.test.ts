import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GithubWatchEvent } from "@abacus-ai/contract/contract/github";
import { describe, expect, it } from "vitest";

import { parseGithubRemote } from "./git-service";
import {
  checkRepo,
  emptyRepoMemory,
  findFailedRuns,
  findNewPrs,
  findNotes,
  githubFixPrompt,
  githubPingNote,
  githubPingText,
  GithubRest,
  GithubWatch,
  GithubWatchStore,
  type WatchNote,
  type WatchPr,
  type WatchRun,
} from "./github-watch";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const ago = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const REPO = "acme/web";
/** The watcher tests read one repo, except the one that checks it reads none while off. */
let REPOS_WATCHED: string[] = [REPO];
const ME = "dev-me";

const pr = (over: Partial<WatchPr> = {}): WatchPr => ({
  number: 42,
  title: "Add login form",
  author: ME,
  head: "feature/login",
  draft: false,
  updatedAt: ago(5),
  createdAt: ago(60),
  url: "https://github.com/acme/web/pull/42",
  reviewers: [],
  ...over,
});

const run = (over: Partial<WatchRun> = {}): WatchRun => ({
  id: 100,
  attempt: 1,
  name: "test",
  branch: "feature/login",
  sha: "abc1234def",
  workflowId: 7,
  status: "completed",
  conclusion: "failure",
  actor: ME,
  createdAt: ago(3),
  url: "https://github.com/acme/web/actions/runs/100",
  ...over,
});

const note = (over: Partial<WatchNote> = {}): WatchNote => ({
  author: "reviewer-a",
  bot: false,
  kind: "comment",
  body: "Can we cap this per key?",
  at: ago(2),
  conversation: false,
  ...over,
});

const words = (key: string, values?: Record<string, string | number>) =>
  `${key}${values == null ? "" : JSON.stringify(values)}`;

describe("new pull requests", () => {
  it("records what is open on the first read and tells nothing", () => {
    const memory = emptyRepoMemory();
    const found = findNewPrs(
      REPO,
      memory,
      [pr({ author: "other" })],
      ME,
      NOW,
      true
    );
    expect(found).toEqual([]);
    expect(memory.seenPrs).toEqual([42]);
  });

  it("tells someone else's new PR once, and says when it asks for my review", () => {
    const memory = emptyRepoMemory();
    const incoming = pr({
      number: 44,
      author: "other",
      reviewers: [ME.toUpperCase()],
    });
    const first = findNewPrs(REPO, memory, [incoming], ME, NOW, false);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "pr",
      number: 44,
      waitsOnYou: true,
    });
    expect(findNewPrs(REPO, memory, [incoming], ME, NOW, false)).toEqual([]);
  });

  it("skips my own PRs, drafts and old ones", () => {
    const memory = emptyRepoMemory();
    const found = findNewPrs(
      REPO,
      memory,
      [
        pr({ number: 1 }),
        pr({ number: 2, author: "other", draft: true }),
        pr({ number: 3, author: "other", createdAt: ago(60 * 48) }),
      ],
      ME,
      NOW,
      false
    );
    expect(found).toEqual([]);
  });
});

describe("reviews and comments on my PRs", () => {
  it("only sets a mark the first time it sees a PR", () => {
    const memory = emptyRepoMemory();
    expect(findNotes(REPO, memory, pr(), [note()], ME, NOW)).toBeNull();
    expect(memory.notesSince["42"]).toBe(ago(2));
  });

  it("groups new notes into one event and moves the mark", () => {
    const memory = emptyRepoMemory();
    memory.notesSince["42"] = ago(10);
    const event = findNotes(
      REPO,
      memory,
      pr(),
      [
        note({ at: ago(20), body: "old" }),
        note({
          kind: "CHANGES_REQUESTED",
          body: "",
          at: ago(4),
          author: "reviewer-b",
        }),
        note(),
        note({ author: ME, body: "thanks", at: ago(1) }),
        note({
          author: "vercel[bot]",
          bot: true,
          conversation: true,
          at: ago(1),
        }),
        note({ kind: "COMMENTED", body: " ", at: ago(3) }),
      ],
      ME,
      NOW
    );
    expect(event).toMatchObject({
      kind: "review",
      who: ["reviewer-b", "reviewer-a"],
      verdict: "changes",
      detail: "Can we cap this per key?",
    });
    expect(memory.notesSince["42"]).toBe(ago(1));
    expect(findNotes(REPO, memory, pr(), [note()], ME, NOW)).toBeNull();
  });

  it("keeps a review bot's review but not a bot's conversation comment", () => {
    const memory = emptyRepoMemory();
    memory.notesSince["42"] = ago(10);
    const event = findNotes(
      REPO,
      memory,
      pr(),
      [
        note({
          author: "review-bot[bot]",
          bot: true,
          body: "Possible null deref",
        }),
      ],
      ME,
      NOW
    );
    expect(event?.who).toEqual(["review-bot[bot]"]);
  });
});

describe("failed runs", () => {
  it("tells a failure on my PR's branch once, grouped by commit", () => {
    const memory = emptyRepoMemory();
    const runs = [run(), run({ id: 101, name: "lint", workflowId: 8 })];
    const found = findFailedRuns(REPO, memory, runs, [pr()], ME, NOW, false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "ci",
      number: 42,
      detail: "test, lint",
      runIds: [100, 101],
    });
    expect(findFailedRuns(REPO, memory, runs, [pr()], ME, NOW, false)).toEqual(
      []
    );
  });

  it("tells a re-run that fails again, as a new attempt", () => {
    const memory = emptyRepoMemory();
    findFailedRuns(REPO, memory, [run()], [pr()], ME, NOW, false);
    expect(
      findFailedRuns(
        REPO,
        memory,
        [run({ attempt: 2 })],
        [pr()],
        ME,
        NOW,
        false
      )
    ).toHaveLength(1);
  });

  it("drops a failure that already passed again on that branch", () => {
    const memory = emptyRepoMemory();
    const runs = [
      run({ createdAt: ago(10) }),
      run({ id: 102, conclusion: "success", createdAt: ago(2) }),
    ];
    expect(findFailedRuns(REPO, memory, runs, [pr()], ME, NOW, false)).toEqual(
      []
    );
  });

  it("tells the default branch, and ignores someone else's branch", () => {
    const memory = emptyRepoMemory();
    memory.defaultBranch = "main";
    const found = findFailedRuns(
      REPO,
      memory,
      [
        run({ id: 1, branch: "main", actor: "other", sha: "m1" }),
        run({ id: 2, branch: "their-thing", actor: "other", sha: "t1" }),
      ],
      [],
      ME,
      NOW,
      false
    );
    expect(found.map((event) => event.branch)).toEqual(["main"]);
  });

  it("records failures on the first read without telling them", () => {
    const memory = emptyRepoMemory();
    expect(
      findFailedRuns(REPO, memory, [run()], [pr()], ME, NOW, true)
    ).toEqual([]);
    expect(
      findFailedRuns(REPO, memory, [run()], [pr()], ME, NOW, false)
    ).toEqual([]);
  });
});

/** A fake GitHub: answers by path, counts requests, honours ETags. */
const fakeGithub = (routes: Record<string, unknown>) => {
  const calls: string[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    calls.push(path);
    const body = routes[path.split("&since=")[0]!] ?? routes[path];
    if (body === undefined) return new Response("{}", { status: 404 });
    const etag = `"${Buffer.from(JSON.stringify(body)).toString("base64")}"`;
    const sent = (init?.headers as Record<string, string> | undefined)?.[
      "If-None-Match"
    ];
    if (sent === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { etag },
    });
  }) as typeof fetch;
  return { calls, doFetch, routes };
};

const apiPr = (over: Record<string, unknown> = {}) => ({
  number: 42,
  title: "Add login form",
  user: { login: ME },
  head: { ref: "feature/login" },
  draft: false,
  updated_at: ago(5),
  created_at: ago(60),
  html_url: "https://github.com/acme/web/pull/42",
  requested_reviewers: [],
  ...over,
});

describe("one check of a repo", () => {
  it("costs two conditional requests when nothing changed", async () => {
    const github = fakeGithub({
      [`/repos/${REPO}`]: { default_branch: "main" },
      [`/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=50`]:
        [apiPr()],
      [`/repos/${REPO}/actions/runs?per_page=30`]: { workflow_runs: [] },
    });
    const api = new GithubRest(() => "t", github.doFetch);
    const memory = emptyRepoMemory();
    expect(await checkRepo(api, REPO, memory, ME, NOW, true)).toEqual([]);
    github.calls.length = 0;
    expect(await checkRepo(api, REPO, memory, ME, NOW + 60_000, false)).toEqual(
      []
    );
    expect(github.calls).toEqual([
      `/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
      `/repos/${REPO}/actions/runs?per_page=30`,
    ]);
  });

  it("reads notes only for my PR that changed, and finds the new review", async () => {
    const github = fakeGithub({
      [`/repos/${REPO}`]: { default_branch: "main" },
      [`/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=50`]:
        [apiPr()],
      [`/repos/${REPO}/actions/runs?per_page=30`]: { workflow_runs: [] },
    });
    const api = new GithubRest(() => "t", github.doFetch);
    const memory = emptyRepoMemory();
    await checkRepo(api, REPO, memory, ME, NOW - 60_000, true);
    github.routes[
      `/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=50`
    ] = [apiPr({ updated_at: ago(0) })];
    github.routes[`/repos/${REPO}/pulls/42/reviews?per_page=100`] = [
      {
        user: { login: "reviewer-a" },
        state: "CHANGES_REQUESTED",
        body: "Needs a test",
        submitted_at: ago(0),
      },
    ];
    github.routes[`/repos/${REPO}/pulls/42/comments?per_page=100`] = [];
    github.routes[`/repos/${REPO}/issues/42/comments?per_page=100`] = [];
    const found = await checkRepo(api, REPO, memory, ME, NOW, false);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "review",
      verdict: "changes",
      detail: "Needs a test",
    });
  });
});

describe("the watcher", () => {
  const store = () =>
    new GithubWatchStore(() =>
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gh-watch-")), "w.json")
    );

  it("does nothing while off, and asks for no token", async () => {
    REPOS_WATCHED = [];
    let asked = 0;
    const watch = new GithubWatch({
      store: store(),
      token: async () => {
        asked += 1;
        return "t";
      },
      allowed: () => true,
      repos: async () => REPOS_WATCHED,
      workspaceFor: async () => null,
      found: () => undefined,
    });
    await watch.check();
    expect(asked).toBe(0);
  });

  it("says no-token when there is no way to read GitHub", async () => {
    REPOS_WATCHED = [REPO];
    const kept = store();
    kept.setConfig({ on: true, repos: [REPO], phoneFix: false });
    const watch = new GithubWatch({
      store: kept,
      token: async () => null,
      allowed: () => true,
      repos: async () => REPOS_WATCHED,
      workspaceFor: async () => null,
      found: () => undefined,
    });
    await watch.check();
    expect(watch.problem()).toBe("no-token");
  });

  it("seeds quietly, then tells a new failure with its project and fix prompt", async () => {
    const kept = store();
    kept.setConfig({ on: true, repos: [REPO], phoneFix: true });
    const github = fakeGithub({
      "/user": { login: ME },
      [`/repos/${REPO}`]: { default_branch: "main" },
      [`/repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=50`]:
        [apiPr()],
      [`/repos/${REPO}/actions/runs?per_page=30`]: { workflow_runs: [] },
    });
    const told: GithubWatchEvent[][] = [];
    let now = NOW;
    const watch = new GithubWatch({
      store: kept,
      token: async () => "t",
      allowed: () => true,
      repos: async () => REPOS_WATCHED,
      workspaceFor: async () => "ws-1",
      found: (events) => told.push(events),
      doFetch: github.doFetch,
      now: () => now,
    });
    await watch.check();
    expect(told).toEqual([]);
    github.routes[`/repos/${REPO}/actions/runs?per_page=30`] = {
      workflow_runs: [
        {
          id: 900,
          run_attempt: 1,
          name: "test",
          head_branch: "feature/login",
          head_sha: "abc",
          workflow_id: 1,
          status: "completed",
          conclusion: "failure",
          actor: { login: ME },
          created_at: ago(0),
          html_url: "https://github.com/acme/web/actions/runs/900",
        },
      ],
    };
    now = NOW + 60_000;
    await watch.check();
    expect(told).toHaveLength(1);
    expect(told[0]![0]).toMatchObject({
      kind: "ci",
      workspaceId: "ws-1",
      whileAway: false,
    });
    expect(told[0]![0]!.prompt).toContain("gh run view <run id> --log-failed");
    expect(told[0]![0]!.prompt).toContain("900");
    expect(kept.events()).toHaveLength(1);
  });

  it("waits out a rate limit", async () => {
    const kept = store();
    kept.setConfig({ on: true, repos: [REPO], phoneFix: false });
    let calls = 0;
    const watch = new GithubWatch({
      store: kept,
      token: async () => "t",
      allowed: () => true,
      repos: async () => REPOS_WATCHED,
      workspaceFor: async () => null,
      found: () => undefined,
      doFetch: (async () => {
        calls += 1;
        return new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 600),
          },
        });
      }) as typeof fetch,
      now: () => NOW,
    });
    await watch.check();
    expect(watch.problem()).toBe("rate-limited");
    await watch.check();
    expect(calls).toBe(1);
  });
});

describe("what the user is told", () => {
  const event = (over: Partial<GithubWatchEvent> = {}): GithubWatchEvent => ({
    id: "ci:acme/web@abc:900.1",
    kind: "ci",
    repo: REPO,
    number: 42,
    title: "Add login form",
    branch: "feature/login",
    url: "https://github.com/acme/web/actions/runs/900",
    who: [ME],
    detail: "test",
    verdict: null,
    waitsOnYou: false,
    at: ago(1),
    whileAway: false,
    workspaceId: "ws-1",
    prompt: "fix it",
    fix: { state: "none", sessionId: null },
    ...over,
  });

  it("ends on the reply that fixes, or on opening the app", () => {
    expect(githubPingText([event()], words, true)).toMatch(
      /githubWatch\.ping\.replyFix$/
    );
    expect(githubPingText([event({ kind: "pr" })], words, true)).toMatch(
      /githubWatch\.ping\.replyReview$/
    );
    expect(githubPingText([event()], words, false)).toMatch(
      /githubWatch\.ping\.openApp$/
    );
  });

  it("shows three and counts the rest", () => {
    const text = githubPingText(
      [1, 2, 3, 4, 5].map((n) => event({ id: `e${n}`, number: n })),
      words,
      true
    );
    expect(text.match(/githubWatch\.line\.ci/g)).toHaveLength(3);
    expect(text).toContain('githubWatch.ping.more{"count":2}');
  });

  it("names each event's id in the chat's note", () => {
    const text = githubPingNote([event()], ["WhatsApp"], words);
    expect(text).toContain("[github watch]");
    expect(text).toContain("event_id ci:acme/web@abc:900.1");
    expect(text).toContain("github_fix");
  });

  it("asks a fix to keep the user's checkout untouched and push to the branch", () => {
    const prompt = githubFixPrompt({ ...event(), runIds: [900] });
    expect(prompt).toContain("git worktree add");
    expect(prompt).toContain("push");
    const review = githubFixPrompt({ ...event({ kind: "pr" }), runIds: [] });
    expect(review).toContain("Do not approve, comment or push");
  });
});

describe("the daily ping allowance and notes", () => {
  it("allows ten a day and starts again the next day", () => {
    const kept = new GithubWatchStore(() => null);
    for (let i = 0; i < 10; i += 1)
      expect(kept.takePing("2026-11-13", 10)).toBe(true);
    expect(kept.takePing("2026-11-13", 10)).toBe(false);
    expect(kept.takePing("2026-11-14", 10)).toBe(true);
  });

  it("owes a note once and drops it a day later", () => {
    const kept = new GithubWatchStore(() => null);
    kept.addNote("chat", "a note", NOW);
    const owed = kept.notesFor("chat", NOW + 1000);
    expect(owed.notes).toEqual(["a note"]);
    owed.taken();
    expect(kept.notesFor("chat", NOW + 2000).notes).toEqual([]);
    kept.addNote("chat", "late", NOW);
    expect(kept.notesFor("chat", NOW + 25 * 60 * 60_000).notes).toEqual([]);
  });
});

describe("the review mark a review routine reads", () => {
  it("says whether a review was found after a time, per repo", () => {
    const kept = new GithubWatchStore(() => null);
    expect(kept.reviewFoundSince(REPO, 0)).toBe(false);
    kept.noteReviewFound(REPO, NOW);
    expect(kept.reviewFoundSince(REPO, NOW - 1)).toBe(true);
    expect(kept.reviewFoundSince(REPO, NOW)).toBe(false);
    expect(kept.reviewFoundSince("other/repo", 0)).toBe(false);
  });

  it("forgets what it read of a repo no longer read", () => {
    const kept = new GithubWatchStore(() => null);
    kept.memory(REPO);
    kept.memory("other/repo");
    kept.keepOnly([REPO]);
    expect(kept.memoryOf(REPO)).not.toBeNull();
    expect(kept.memoryOf("other/repo")).toBeNull();
  });
});

describe("a project's GitHub repo", () => {
  it.each([
    ["https://github.com/acme/web.git", "acme/web"],
    ["https://github.com/acme/web", "acme/web"],
    ["git@github.com:acme/web.git", "acme/web"],
    ["ssh://git@github.com/acme/web.git", "acme/web"],
    ["https://x-access-token@github.com/acme/web.git", "acme/web"],
    ["https://gitlab.com/acme/web.git", null],
    ["", null],
  ])("%s → %s", (url, repo) => {
    expect(parseGithubRemote(url)).toBe(repo);
  });
});
