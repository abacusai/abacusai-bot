/**
 * GitHub for a checkout through the user's `gh` (spec 04 §14.3): its install
 * and sign-in state, the branch's pull request in full, its diff, and a
 * review. The integration pref is the caller's to check; this
 * service only runs `gh` when asked.
 */
import type {
  GithubStatus,
  PrResult,
} from "@abacus-ai/contract/contract/github";

import {
  GhError,
  ghStatusMessage,
  parseAuthStatusJson,
  parseAuthStatusText,
  parseGhVersion,
  runGh,
  type GhAuth,
  type GhRunner,
} from "./github-cli";
import { PR_DETAIL_FIELDS, parsePrDetailJson } from "./github-pr-json";

export type PrVerdict = "comment" | "approve" | "request_changes";

const STATUS_TTL_MS = 30_000;
/** Missing or signed out is likely being fixed right now; look again sooner. */
const STATUS_RETRY_TTL_MS = 10_000;
export const PR_DIFF_CAP = 4 * 1024 * 1024;

export const DISABLED_STATUS: GithubStatus = {
  state: "disabled",
  version: null,
  account: null,
  host: null,
  message: null,
};

const VERDICT_FLAGS: Record<PrVerdict, string> = {
  comment: "--comment",
  approve: "--approve",
  request_changes: "--request-changes",
};

/** A refusal the procedures map to a contract error. */
export class GithubRequestError extends Error {
  constructor(
    readonly reason:
      | "empty-body"
      | "pr-mismatch"
      | "gh-missing"
      | "gh-unauthenticated"
      | "gh-timeout"
      | "gh-error",
    message: string
  ) {
    super(message);
    this.name = "GithubRequestError";
  }
}

const requestError = (error: unknown): unknown => {
  if (!(error instanceof GhError)) return error;
  switch (error.kind) {
    case "missing":
      return new GithubRequestError("gh-missing", error.message);
    case "unauthenticated":
      return new GithubRequestError("gh-unauthenticated", error.message);
    case "timeout":
      return new GithubRequestError("gh-timeout", error.message);
    default:
      return new GithubRequestError("gh-error", error.message);
  }
};

const branchFrom = (message: string): string | null =>
  /for branch "([^"]+)"/.exec(message)?.[1] ?? null;

export class GithubService {
  private readonly run: GhRunner;
  private readonly now: () => number;
  private cached: { status: GithubStatus; until: number } | null = null;
  private probing: Promise<GithubStatus> | null = null;
  /** Bumped per probe: only the newest one writes the cache. */
  private generation = 0;

  constructor(options: { run?: GhRunner; now?: () => number } = {}) {
    this.run = options.run ?? runGh;
    this.now = options.now ?? Date.now;
  }

  /** Cached 30 s (10 s when missing or signed out); `refresh` probes anew. */
  async status(refresh = false): Promise<GithubStatus> {
    if (!refresh && this.cached != null && this.cached.until > this.now())
      return this.cached.status;
    if (!refresh && this.probing != null) return this.probing;
    const generation = ++this.generation;
    const probe = this.probe().then((status) => {
      // An older probe that finishes late must not undo a newer answer.
      if (generation === this.generation)
        this.cached = {
          status,
          until:
            this.now() +
            (status.state === "ok" ? STATUS_TTL_MS : STATUS_RETRY_TTL_MS),
        };
      return status;
    });
    this.probing = probe;
    let status: GithubStatus;
    try {
      status = await probe;
    } finally {
      if (this.probing === probe) this.probing = null;
    }
    if (generation === this.generation) return status;
    // A newer probe started meanwhile: its answer is the one that counts.
    return this.probing ?? this.cached?.status ?? status;
  }

  private async probe(): Promise<GithubStatus> {
    let version: string | null;
    try {
      version = parseGhVersion((await this.run(["--version"])).stdout);
    } catch (error) {
      return {
        state:
          error instanceof GhError && error.kind === "missing"
            ? "missing"
            : "error",
        version: null,
        account: null,
        host: null,
        ...ghStatusMessage(error),
      };
    }
    const auth = await this.auth();
    return auth.signedIn
      ? {
          state: "ok",
          version,
          account: auth.account,
          host: auth.host,
          message: null,
        }
      : {
          state: "unauthenticated",
          version,
          account: null,
          host: null,
          message: auth.message,
          // The app's own sentence ("run `gh auth login`").
          userFacing: auth.message != null,
        };
  }

  /** The JSON form first; gh before 2.81 does not know `--json` here. */
  private async auth(): Promise<GhAuth> {
    try {
      const parsed = parseAuthStatusJson(
        (await this.run(["auth", "status", "--json", "hosts"])).stdout
      );
      if (parsed != null) return parsed;
    } catch {
      // Older gh: "unknown flag: --json". The text form below decides.
    }
    try {
      const { stdout, stderr } = await this.run(["auth", "status"]);
      return parseAuthStatusText(`${stdout}\n${stderr}`, true);
    } catch (error) {
      return parseAuthStatusText(
        error instanceof GhError ? error.stderr : "",
        false
      );
    }
  }

  /** The checkout's current-branch pull request; never throws. */
  async pr(checkout: string | null): Promise<PrResult> {
    if (checkout == null) return { kind: "unsupported" };
    try {
      const { stdout } = await this.run(
        ["pr", "view", "--json", PR_DETAIL_FIELDS],
        { cwd: checkout }
      );
      const pr = parsePrDetailJson(stdout);
      return pr == null
        ? {
            kind: "unavailable",
            status: {
              ...(await this.status()),
              state: "error",
              message: "GitHub CLI answered with something unreadable",
              userFacing: true,
            },
          }
        : { kind: "ok", pr };
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      switch (error.kind) {
        case "none":
          return { kind: "none", branch: branchFrom(error.message) };
        case "unsupported":
          return { kind: "unsupported" };
        case "missing":
        case "unauthenticated":
          // The cache may still say "ok"; what just failed is newer.
          return { kind: "unavailable", status: await this.status(true) };
        default:
          return {
            kind: "unavailable",
            status: {
              ...(await this.status()),
              state: "error",
              ...ghStatusMessage(error),
            },
          };
      }
    }
  }

  /**
   * `gh pr diff`, cut at 4 MB. It names the PR by number, so it reads that
   * PR whatever branch the checkout is on now; no current-PR check.
   */
  async prDiff(
    checkout: string,
    number: number
  ): Promise<{ diff: string; truncated: boolean }> {
    try {
      const { stdout, truncated } = await this.run(
        ["pr", "diff", String(number), "--color=never"],
        { cwd: checkout, maxBuffer: PR_DIFF_CAP, timeoutMs: 30_000 }
      );
      return { diff: stdout, truncated };
    } catch (error) {
      throw requestError(error);
    }
  }

  /** A review; a comment or change request needs a body, an approval may omit it. */
  async review(
    checkout: string,
    number: number,
    verdict: PrVerdict,
    body: string
  ): Promise<void> {
    const text = body.trim();
    if (text.length === 0 && verdict !== "approve")
      throw new GithubRequestError(
        "empty-body",
        verdict === "comment"
          ? "A review comment needs some text"
          : "A change request needs some text"
      );
    await this.assertCurrentPr(checkout, number);
    try {
      await this.run(
        [
          "pr",
          "review",
          String(number),
          VERDICT_FLAGS[verdict],
          ...(text.length === 0 ? [] : ["--body-file", "-"]),
        ],
        { cwd: checkout, input: text, timeoutMs: 30_000 }
      );
    } catch (error) {
      throw requestError(error);
    }
  }

  /**
   * The tab acts on the PR it shows; if the checkout moved to another branch
   * since, acting on "the current PR" would hit the wrong one.
   */
  private async assertCurrentPr(
    checkout: string,
    number: number
  ): Promise<void> {
    let current: number | null = null;
    try {
      const { stdout } = await this.run(["pr", "view", "--json", "number"], {
        cwd: checkout,
      });
      const parsed: unknown = JSON.parse(stdout);
      const value = (parsed as { number?: unknown } | null)?.number;
      current = typeof value === "number" ? value : null;
    } catch (error) {
      if (!(error instanceof GhError)) {
        current = null;
      } else if (error.kind !== "none" && error.kind !== "unsupported") {
        throw requestError(error);
      }
    }
    if (current !== number)
      throw new GithubRequestError(
        "pr-mismatch",
        current == null
          ? `This checkout no longer has pull request #${number}`
          : `This checkout is on pull request #${current} now, not #${number}`
      );
  }
}
