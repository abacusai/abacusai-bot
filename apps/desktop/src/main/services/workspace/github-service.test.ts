import { describe, expect, it, vi } from "vitest";

import {
  classifyGhFailure,
  type GhOutput,
  type GhRunOptions,
} from "./github-cli";
import { GithubService } from "./github-service";

type Reply =
  | string
  | { fail: Parameters<typeof classifyGhFailure>[0] }
  | GhOutput;

/** A `gh` that answers by its first matching argument prefix. */
const fakeGh = (replies: Array<[string, Reply]>) =>
  vi.fn(async (args: readonly string[], _options?: GhRunOptions) => {
    const line = args.join(" ");
    const reply = replies.find(([prefix]) => line.startsWith(prefix))?.[1];
    if (reply == null) throw new Error(`unexpected gh ${line}`);
    if (typeof reply === "string")
      return { stdout: reply, stderr: "", truncated: false };
    if ("fail" in reply) throw classifyGhFailure(reply.fail);
    return reply;
  });

const SIGNED_IN = JSON.stringify({
  hosts: {
    "github.com": [
      { state: "success", active: true, host: "github.com", login: "octocat" },
    ],
  },
});
const VERSION = "gh version 2.102.0 (2026-09-30)\n";
const PR_JSON = JSON.stringify({
  number: 7,
  url: "https://github.com/a/b/pull/7",
  state: "OPEN",
});

describe("status", () => {
  it("is ok with the version and the active account", async () => {
    const run = fakeGh([
      ["--version", VERSION],
      ["auth status --json", SIGNED_IN],
    ]);
    expect(await new GithubService({ run }).status()).toEqual({
      state: "ok",
      version: "2.102.0",
      account: "octocat",
      host: "github.com",
      message: null,
    });
  });

  it("is missing when gh is not installed", async () => {
    const run = fakeGh([["--version", { fail: { code: "ENOENT" } }]]);
    expect(await new GithubService({ run }).status()).toMatchObject({
      state: "missing",
      version: null,
    });
  });

  it("falls back to the text form on a gh without `auth status --json`", async () => {
    const run = fakeGh([
      ["--version", "gh version 2.40.0 (2023-12-01)"],
      [
        "auth status --json",
        { fail: { code: 1, stderr: "unknown flag: --json" } },
      ],
      [
        "auth status",
        {
          stdout: "",
          stderr:
            "github.com\n  ✓ Logged in to github.com as octocat (oauth_token)",
          truncated: false,
        },
      ],
    ]);
    expect(await new GithubService({ run }).status()).toMatchObject({
      state: "ok",
      version: "2.40.0",
      account: "octocat",
    });
  });

  it("is unauthenticated when the text form exits non-zero", async () => {
    const run = fakeGh([
      ["--version", "gh version 2.40.0 (2023-12-01)"],
      [
        "auth status --json",
        { fail: { code: 1, stderr: "unknown flag: --json" } },
      ],
      [
        "auth status",
        {
          fail: {
            code: 1,
            stderr:
              "You are not logged into any GitHub hosts. Run gh auth login",
          },
        },
      ],
    ]);
    expect(await new GithubService({ run }).status()).toMatchObject({
      state: "unauthenticated",
      version: "2.40.0",
    });
  });

  it("caches 30 s when ok, 10 s otherwise, and probes anew on refresh", async () => {
    let now = 0;
    const run = fakeGh([
      ["--version", VERSION],
      ["auth status --json", SIGNED_IN],
    ]);
    const service = new GithubService({ run, now: () => now });
    await service.status();
    now = 29_000;
    await service.status();
    expect(run).toHaveBeenCalledTimes(2);
    await service.status(true);
    expect(run).toHaveBeenCalledTimes(4);
    now = 29_000 + 30_001;
    await service.status();
    expect(run).toHaveBeenCalledTimes(6);

    const missing = fakeGh([["--version", { fail: { code: "ENOENT" } }]]);
    const offline = new GithubService({ run: missing, now: () => now });
    await offline.status();
    now += 9_000;
    await offline.status();
    expect(missing).toHaveBeenCalledTimes(1);
    now += 2_000;
    await offline.status();
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest probe's answer when an older one finishes last", async () => {
    // The first `--version` hangs until released; the refresh's answers at once.
    let release: (() => void) | undefined;
    let versions = 0;
    let signedIn = false;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "--version") {
        versions += 1;
        if (versions === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { stdout: VERSION, stderr: "", truncated: false };
      }
      // The stale probe asks auth last, after the user signed out.
      return signedIn
        ? { stdout: SIGNED_IN, stderr: "", truncated: false }
        : {
            stdout: JSON.stringify({ hosts: {} }),
            stderr: "",
            truncated: false,
          };
    });
    const service = new GithubService({ run });
    const stale = service.status();
    await vi.waitFor(() => expect(release).toBeDefined());
    signedIn = true;
    expect((await service.status(true)).state).toBe("ok");
    signedIn = false;
    release!();
    // The stale caller is handed the newest answer, and the cache keeps it.
    expect((await stale).state).toBe("ok");
    expect((await service.status()).state).toBe("ok");
    expect(versions).toBe(2);
  });

  it("shares one probe between concurrent callers", async () => {
    const run = fakeGh([
      ["--version", VERSION],
      ["auth status --json", SIGNED_IN],
    ]);
    const service = new GithubService({ run });
    await Promise.all([service.status(), service.status()]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("pr", () => {
  it("is unsupported without a local checkout, and runs nothing", async () => {
    const run = fakeGh([]);
    expect(await new GithubService({ run }).pr(null)).toEqual({
      kind: "unsupported",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("reads the pull request in the checkout", async () => {
    const run = fakeGh([["pr view --json", PR_JSON]]);
    const result = await new GithubService({ run }).pr("/repo");
    expect(result).toMatchObject({ kind: "ok", pr: { number: 7 } });
    expect(run.mock.calls[0][1]).toMatchObject({ cwd: "/repo" });
  });

  it("names the branch that has no pull request", async () => {
    const run = fakeGh([
      [
        "pr view",
        {
          fail: {
            code: 1,
            stderr: 'no pull requests found for branch "feat/x"',
          },
        },
      ],
    ]);
    expect(await new GithubService({ run }).pr("/repo")).toEqual({
      kind: "none",
      branch: "feat/x",
    });
  });

  it("is unsupported outside a GitHub checkout", async () => {
    const run = fakeGh([
      ["pr view", { fail: { code: 1, stderr: "no git remotes found" } }],
    ]);
    expect(await new GithubService({ run }).pr("/repo")).toEqual({
      kind: "unsupported",
    });
  });

  it("is unavailable with a fresh status when signed out", async () => {
    const run = fakeGh([
      ["pr view", { fail: { code: 4, stderr: "please run:  gh auth login" } }],
      ["--version", VERSION],
      ["auth status --json", '{"hosts":{}}'],
    ]);
    expect(await new GithubService({ run }).pr("/repo")).toMatchObject({
      kind: "unavailable",
      status: { state: "unauthenticated", version: "2.102.0" },
    });
  });

  it("is unavailable as an error with gh's words otherwise", async () => {
    const run = fakeGh([
      [
        "pr view",
        { fail: { code: 1, stderr: "GraphQL: API rate limit exceeded" } },
      ],
      ["--version", VERSION],
      ["auth status --json", SIGNED_IN],
    ]);
    expect(await new GithubService({ run }).pr("/repo")).toMatchObject({
      kind: "unavailable",
      status: {
        state: "error",
        account: "octocat",
        // gh's plain sentence, marked for the user.
        message: "API rate limit exceeded",
        userFacing: true,
      },
    });
  });
});

describe("prDiff and review", () => {
  const onPr = (number: number, more: Array<[string, Reply]> = []) =>
    fakeGh([["pr view --json number", JSON.stringify({ number })], ...more]);

  it("diffs the pull request by number, passing the cap and truncation through", async () => {
    // The checkout is on another PR now: a diff by number is still #7's.
    const run = onPr(8, [
      ["pr diff", { stdout: "diff --git a b\n", stderr: "", truncated: true }],
    ]);
    expect(await new GithubService({ run }).prDiff("/repo", 7)).toEqual({
      diff: "diff --git a b\n",
      truncated: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]).toEqual([
      ["pr", "diff", "7", "--color=never"],
      { cwd: "/repo", maxBuffer: 4 * 1024 * 1024, timeoutMs: 30_000 },
    ]);
  });

  it("refuses when the checkout moved to another pull request", async () => {
    const run = onPr(8);
    await expect(
      new GithubService({ run }).review("/repo", 7, "approve", "")
    ).rejects.toMatchObject({ reason: "pr-mismatch" });
    expect(run.mock.calls.every(([args]) => args[1] === "view")).toBe(true);
  });

  it("refuses when the branch has no pull request any more", async () => {
    const run = fakeGh([
      [
        "pr view",
        { fail: { code: 1, stderr: 'no pull requests found for branch "x"' } },
      ],
    ]);
    await expect(
      new GithubService({ run }).review("/repo", 7, "comment", "hi")
    ).rejects.toMatchObject({ reason: "pr-mismatch" });
  });

  it("sends the body on stdin with the verdict's flag", async () => {
    const run = onPr(7, [["pr review", ""]]);
    const service = new GithubService({ run });
    await service.review("/repo", 7, "request_changes", "  Please fix  ");
    expect(run.mock.calls[1]).toEqual([
      ["pr", "review", "7", "--request-changes", "--body-file", "-"],
      { cwd: "/repo", input: "Please fix", timeoutMs: 30_000 },
    ]);
    await service.review("/repo", 7, "approve", "");
    expect(run.mock.calls[3][0]).toEqual(["pr", "review", "7", "--approve"]);
  });

  it("refuses an empty review comment or change request before running gh", async () => {
    const run = onPr(7);
    const service = new GithubService({ run });
    for (const verdict of ["comment", "request_changes"] as const)
      await expect(
        service.review("/repo", 7, verdict, "  ")
      ).rejects.toMatchObject({ reason: "empty-body" });
    expect(run).not.toHaveBeenCalled();
  });

  it("surfaces gh's refusal as its first stderr line", async () => {
    const run = onPr(7, [
      [
        "pr review",
        {
          fail: {
            code: 1,
            stderr:
              "failed to create review: GraphQL: Can not approve your own pull request (addPullRequestReview)\n",
          },
        },
      ],
    ]);
    await expect(
      new GithubService({ run }).review("/repo", 7, "approve", "")
    ).rejects.toMatchObject({
      reason: "gh-error",
      message:
        "failed to create review: GraphQL: Can not approve your own pull request (addPullRequestReview)",
    });
  });
});
