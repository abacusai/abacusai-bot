import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

import type {
  CreateGitBranchResult,
  GetGitBranchesResult,
  GetGitCurrentBranchResult,
  GitChangeItem,
  GitChangeStatsScope,
  GitDiffScope,
  InitGitResult,
  PrCheck,
  PrCiStatus,
  PrInfo,
  PrReviewState,
  SwitchGitBranchResult,
  CreateWorktreeResult,
  ListWorktreesResult,
  WorktreeListItem,
} from "#shared/contracts";

import { parseNumstatZ, parseStatusZ } from "./git-porcelain";

const execFileAsync = promisify(execFile);

const worktreeId = (worktreePath: string): string =>
  createHash("sha256")
    .update(path.resolve(worktreePath))
    .digest("hex")
    .slice(0, 20);

const isPathInside = (parent: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

export function parseWorktreePorcelain(
  raw: string,
  workspacePath: string,
  managedRoot: string
): WorktreeListItem[] {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  for (const token of raw.split("\0")) {
    if (token.length === 0) {
      if (current.worktree != null) records.push(current);
      current = {};
      continue;
    }
    const separator = token.indexOf(" ");
    const key = separator === -1 ? token : token.slice(0, separator);
    current[key] = separator === -1 ? "" : token.slice(separator + 1);
  }
  if (current.worktree != null) records.push(current);

  const currentPath = path.resolve(workspacePath);
  return records.map((record) => {
    const checkoutPath = path.resolve(record.worktree);
    const branch = record.branch?.replace(/^refs\/heads\//, "") || null;
    return {
      id: worktreeId(checkoutPath),
      name: path.basename(checkoutPath) || checkoutPath,
      path: checkoutPath,
      branch,
      isCurrent: checkoutPath === currentPath,
      isManaged: isPathInside(managedRoot, checkoutPath),
    };
  });
}

// The empty side of a new file's diff. Git for Windows understands /dev/null in
// --no-index too, but NUL is what that platform actually has.
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

// Fields read from `gh pr view --json`; one place so fetch and parser agree.
const PR_VIEW_FIELDS =
  "number,url,title,state,isDraft,reviewDecision,additions,deletions,statusCheckRollup,reviewRequests,latestReviews";

// Everything is optional: GitHub's shape varies (CheckRun vs StatusContext,
// missing rollup) and a malformed field must never throw.
export function parsePrViewJson(raw: string): PrInfo | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const number = data?.number;
  const url = data?.url;
  if (typeof number !== "number" || number <= 0 || typeof url !== "string") {
    return null;
  }

  const state = data?.state;
  const reviewDecision = data?.reviewDecision;
  let reviewState: PrReviewState = "pending";
  if (state === "MERGED") {
    reviewState = "merged";
  } else if (state === "CLOSED") {
    reviewState = "closed";
  } else if (data?.isDraft === true) {
    reviewState = "draft";
  } else if (reviewDecision === "APPROVED") {
    reviewState = "approved";
  } else if (reviewDecision === "CHANGES_REQUESTED") {
    reviewState = "changes_requested";
  }

  // A single failure wins; otherwise any incomplete check keeps it pending.
  const rollup = Array.isArray(data?.statusCheckRollup)
    ? (data.statusCheckRollup as Array<Record<string, unknown>>)
    : [];
  const checks: PrCheck[] = rollup.map((check) => ({
    name: String(check?.name ?? check?.context ?? "check"),
    status: classifyCheck(check),
    url:
      typeof check?.detailsUrl === "string"
        ? check.detailsUrl
        : typeof check?.targetUrl === "string"
          ? check.targetUrl
          : null,
  }));
  let ciStatus: PrCiStatus | null = null;
  if (checks.length > 0) {
    ciStatus = checks.some((c) => c.status === "failure")
      ? "failure"
      : checks.some((c) => c.status === "pending")
        ? "pending"
        : "success";
  }

  const latestReviews = Array.isArray(data?.latestReviews)
    ? (data.latestReviews as Array<Record<string, unknown>>)
    : [];
  const approvedCount = latestReviews.filter(
    (r) => r?.state === "APPROVED"
  ).length;
  const changesRequestedCount = latestReviews.filter(
    (r) => r?.state === "CHANGES_REQUESTED"
  ).length;
  const reviewRequestedCount = Array.isArray(data?.reviewRequests)
    ? data.reviewRequests.length
    : 0;

  return {
    number,
    url,
    title: typeof data?.title === "string" ? data.title : "",
    reviewState,
    additions: typeof data?.additions === "number" ? data.additions : 0,
    deletions: typeof data?.deletions === "number" ? data.deletions : 0,
    ciStatus,
    checks,
    approvedCount,
    changesRequestedCount,
    reviewRequestedCount,
  };
}

// Map one rollup entry (CheckRun or StatusContext) to a coarse verdict.
function classifyCheck(check: Record<string, unknown>): PrCiStatus {
  const status = String(check?.status ?? "").toUpperCase(); // CheckRun
  const conclusion = String(check?.conclusion ?? "").toUpperCase(); // CheckRun
  const contextState = String(check?.state ?? "").toUpperCase(); // StatusContext
  if (
    [
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ].includes(conclusion) ||
    ["FAILURE", "ERROR"].includes(contextState)
  ) {
    return "failure";
  }
  if (
    contextState === "SUCCESS" ||
    conclusion === "SUCCESS" ||
    (status === "COMPLETED" && conclusion === "")
  ) {
    return "success";
  }
  if (status !== "" && status !== "COMPLETED") {
    return "pending";
  }
  if (contextState === "PENDING") {
    return "pending";
  }
  // Completed with a neutral/skipped conclusion → treat as success (non-blocking).
  return "success";
}

type GitStatusResult = {
  available: boolean;
  changes: GitChangeItem[];
  message: string;
};

type GitChangeStats = {
  additions: number | null;
  deletions: number | null;
};

export class GitService {
  // Workspaces are long-lived and rev-parse would run on every git op.
  // Invalidated by initRepository() and invalidateRepoCache().
  private readonly insideWorkTreeCache = new Map<string, boolean>();

  invalidateRepoCache(workspacePath: string): void {
    this.insideWorkTreeCache.delete(workspacePath);
  }

  private async isInsideWorkTree(workspacePath: string): Promise<boolean> {
    const cached = this.insideWorkTreeCache.get(workspacePath);
    if (cached != null) {
      return cached;
    }
    try {
      const result = await execFileAsync("git", [
        "-C",
        workspacePath,
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      const inside = result.stdout.includes("true");
      this.insideWorkTreeCache.set(workspacePath, inside);
      return inside;
    } catch {
      this.insideWorkTreeCache.set(workspacePath, false);
      return false;
    }
  }

  async initRepository(workspacePath: string): Promise<InitGitResult> {
    try {
      await execFileAsync("git", ["-C", workspacePath, "init"]);
      this.invalidateRepoCache(workspacePath);
      return { success: true };
    } catch (error) {
      const message = this.errorMessage(error);
      if (
        message.includes("not found") ||
        message.includes("command not found") ||
        message.includes("enoent")
      ) {
        return {
          success: false,
          error: "Git is not installed on this machine.",
        };
      }
      return {
        success: false,
        error: "Unable to initialize git for this workspace.",
      };
    }
  }

  async getCurrentBranch(
    workspacePath: string
  ): Promise<GetGitCurrentBranchResult> {
    if (!(await this.isInsideWorkTree(workspacePath))) {
      return {
        success: false,
        currentBranch: null,
        error: "Git is not initialized here.",
      };
    }
    try {
      const output = await execFileAsync("git", [
        "-C",
        workspacePath,
        "branch",
        "--show-current",
      ]);
      return { success: true, currentBranch: output.stdout.trim() || null };
    } catch {
      return {
        success: false,
        currentBranch: null,
        error: "Unable to read current git branch.",
      };
    }
  }

  // `gh` handles its own auth; any failure (no PR, gh missing, timeout) yields
  // null and the UI shows nothing.
  async getPrInfo(workspacePath: string): Promise<PrInfo | null> {
    if (!(await this.isInsideWorkTree(workspacePath))) {
      return null;
    }
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", "--json", PR_VIEW_FIELDS],
        {
          cwd: workspacePath,
          timeout: 10_000,
        }
      );
      return parsePrViewJson(stdout);
    } catch {
      return null;
    }
  }

  async listBranches(workspacePath: string): Promise<GetGitBranchesResult> {
    if (!(await this.isInsideWorkTree(workspacePath))) {
      return {
        success: false,
        branches: [],
        currentBranch: null,
        error: "Git is not initialized here.",
      };
    }

    try {
      const [currentBranchOutput, allBranchesOutput] = await Promise.all([
        execFileAsync("git", ["-C", workspacePath, "branch", "--show-current"]),
        execFileAsync("git", [
          "-C",
          workspacePath,
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname:short)",
          "refs/heads/",
        ]),
      ]);

      const currentBranch = currentBranchOutput.stdout.trim() || null;
      const allBranches = allBranchesOutput.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const branches = this.reorderBranches(allBranches, currentBranch).map(
        (name) => ({
          name,
          isCurrent: name === currentBranch,
        })
      );

      return { success: true, branches, currentBranch };
    } catch {
      return {
        success: false,
        branches: [],
        currentBranch: null,
        error: "Unable to read git branches.",
      };
    }
  }

  private reorderBranches(
    branches: string[],
    currentBranch: string | null
  ): string[] {
    const ordered: string[] = [];
    const remaining = new Set(branches);

    if (currentBranch && remaining.has(currentBranch)) {
      ordered.push(currentBranch);
      remaining.delete(currentBranch);
    }

    const mainBranches = ["main", "master"];
    for (const mainBranch of mainBranches) {
      if (remaining.has(mainBranch)) {
        ordered.push(mainBranch);
        remaining.delete(mainBranch);
      }
    }

    for (const branch of remaining) {
      ordered.push(branch);
    }

    return ordered;
  }

  async switchBranch(
    workspacePath: string,
    branchName: string
  ): Promise<SwitchGitBranchResult> {
    try {
      await execFileAsync("git", ["-C", workspacePath, "switch", branchName]);
      // Trust the requested name; no second git call.
      return { success: true, currentBranch: branchName };
    } catch (error) {
      const message = this.errorMessage(error);
      if (
        message.includes("invalid reference") ||
        message.includes("pathspec")
      ) {
        return {
          success: false,
          currentBranch: null,
          error: "Selected branch does not exist.",
        };
      }
      return {
        success: false,
        currentBranch: null,
        error: "Unable to switch git branch.",
      };
    }
  }

  async createBranch(
    workspacePath: string,
    branchName: string
  ): Promise<CreateGitBranchResult> {
    const normalizedName = branchName.trim();
    if (normalizedName.length === 0) {
      return {
        success: false,
        currentBranch: null,
        error: "Branch name is required.",
      };
    }

    try {
      await execFileAsync("git", [
        "-C",
        workspacePath,
        "switch",
        "-c",
        normalizedName,
      ]);
      return { success: true, currentBranch: normalizedName };
    } catch (error) {
      const message = this.errorMessage(error);
      if (message.includes("already exists")) {
        return {
          success: false,
          currentBranch: null,
          error: "Branch already exists.",
        };
      }
      if (message.includes("not a valid branch name")) {
        return {
          success: false,
          currentBranch: null,
          error: "Invalid branch name.",
        };
      }
      return {
        success: false,
        currentBranch: null,
        error: "Unable to create git branch.",
      };
    }
  }

  async listWorktrees(
    workspacePath: string,
    managedRoot: string
  ): Promise<ListWorktreesResult> {
    if (!(await this.isInsideWorkTree(workspacePath))) {
      return {
        success: false,
        worktrees: [],
        error: "Git is not initialized here.",
      };
    }
    try {
      const { stdout } = await execFileAsync("git", [
        "-C",
        workspacePath,
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      // Git for Windows reports canonical paths, so a workspace or managed root
      // reached through a junction may spell the same directory differently.
      // Compare canonical roots so managed worktrees stay removable.
      const [canonicalWorkspacePath, canonicalManagedRoot] = await Promise.all([
        fs.realpath(workspacePath).catch(() => workspacePath),
        fs.realpath(managedRoot).catch(() => managedRoot),
      ]);
      return {
        success: true,
        worktrees: parseWorktreePorcelain(
          stdout,
          canonicalWorkspacePath,
          canonicalManagedRoot
        ),
      };
    } catch {
      return {
        success: false,
        worktrees: [],
        error: "Unable to read Git worktrees.",
      };
    }
  }

  async createWorktree(
    workspacePath: string,
    managedRoot: string,
    baseRef: string,
    requestedName?: string
  ): Promise<CreateWorktreeResult> {
    if (!(await this.isInsideWorkTree(workspacePath))) {
      return { success: false, error: "Git is not initialized here." };
    }
    const normalizedBase = baseRef.trim();
    if (normalizedBase.length === 0) {
      return { success: false, error: "A base ref is required." };
    }
    const slug =
      (requestedName?.trim() || "worktree")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "worktree";
    const suffix = randomUUID().slice(0, 8);
    const branch = `abacus/${slug}-${suffix}`;
    const checkoutPath = path.join(managedRoot, `${slug}-${suffix}`);

    try {
      await execFileAsync("git", [
        "-C",
        workspacePath,
        "rev-parse",
        "--verify",
        `${normalizedBase}^{commit}`,
      ]);
    } catch {
      return {
        success: false,
        error: "The selected base ref does not exist.",
      };
    }

    try {
      await fs.mkdir(managedRoot, { recursive: true });
      await execFileAsync("git", [
        "-C",
        workspacePath,
        "worktree",
        "add",
        "-b",
        branch,
        checkoutPath,
        normalizedBase,
      ]);
      return {
        success: true,
        worktree: {
          id: worktreeId(checkoutPath),
          name: path.basename(checkoutPath),
          path: checkoutPath,
          branch,
          isCurrent: false,
          isManaged: true,
        },
      };
    } catch {
      await fs
        .rm(checkoutPath, { recursive: true, force: true })
        .catch(() => {});
      return {
        success: false,
        error: "Unable to create Git worktree.",
      };
    }
  }

  async removeManagedWorktree(
    workspacePath: string,
    managedRoot: string,
    checkoutPath: string
  ): Promise<void> {
    if (!isPathInside(managedRoot, checkoutPath)) return;
    await execFileAsync("git", [
      "-C",
      workspacePath,
      "worktree",
      "remove",
      "--force",
      checkoutPath,
    ]).catch(() => undefined);
    await fs.rm(checkoutPath, { recursive: true, force: true }).catch(() => {});
  }

  async readGitChanges(workspacePath: string): Promise<GitStatusResult> {
    if (!(await this.isInsideWorkTree(workspacePath))) {
      return {
        available: false,
        changes: [],
        message: "Git is not initialized here.",
      };
    }

    try {
      const statusOutput = await execFileAsync("git", [
        "-C",
        workspacePath,
        "status",
        "--porcelain",
        "-uall",
        "-z",
      ]);
      const changes = parseStatusZ(statusOutput.stdout).sort((a, b) =>
        a.path.localeCompare(b.path)
      );

      return {
        available: true,
        changes,
        message:
          changes.length === 0
            ? "Working tree is clean."
            : `${changes.length} changed file(s).`,
      };
    } catch (error) {
      return this.mapGitError(error);
    }
  }

  async readChangeStatsForPath(
    workspacePath: string,
    filePath: string,
    scope: GitChangeStatsScope = "all"
  ): Promise<GitChangeStats> {
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const candidatePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(normalizedWorkspacePath, filePath);
    const relativePath = path.relative(normalizedWorkspacePath, candidatePath);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("..") ||
      path.isAbsolute(relativePath)
    ) {
      return { additions: null, deletions: null };
    }

    const stats = new Map<string, GitChangeStats>();
    const tasks: Promise<void>[] = [];
    if (scope === "all" || scope === "unstaged") {
      tasks.push(
        this.mergeDiffNumstat(stats, workspacePath, [
          "diff",
          "--numstat",
          "--find-renames",
          "--submodule=diff",
          "--no-ext-diff",
          "-z",
          "--",
          relativePath,
        ])
      );
    }
    if (scope === "all" || scope === "staged") {
      tasks.push(
        this.mergeDiffNumstat(stats, workspacePath, [
          "diff",
          "--numstat",
          "--cached",
          "--find-renames",
          "--submodule=diff",
          "--no-ext-diff",
          "--",
          relativePath,
        ])
      );
    }
    await Promise.all(tasks);

    const normalizedPath = relativePath.replace(/\\/g, "/");
    return stats.get(normalizedPath) ?? { additions: null, deletions: null };
  }

  async buildUnifiedDiffForPath(
    workspacePath: string,
    filePath: string,
    scope: GitDiffScope = "unstaged"
  ): Promise<string> {
    try {
      const normalizedWorkspacePath = path.resolve(workspacePath);
      const candidatePath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(normalizedWorkspacePath, filePath);
      const relativePath = path.relative(
        normalizedWorkspacePath,
        candidatePath
      );
      if (
        relativePath.length === 0 ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
      ) {
        return "";
      }
      const args =
        scope === "staged"
          ? [
              "-C",
              workspacePath,
              "diff",
              "--cached",
              "--no-color",
              "--find-renames",
              "--submodule=diff",
              "--no-ext-diff",
              "--",
              relativePath,
            ]
          : [
              "-C",
              workspacePath,
              "diff",
              "--no-color",
              "--find-renames",
              "--submodule=diff",
              "--no-ext-diff",
              "--",
              relativePath,
            ];
      const output = await execFileAsync("git", args);
      const diff = output.stdout ?? "";

      if (diff.trim().length > 0 || scope === "staged") {
        return diff;
      }

      // An untracked file is not in the index, so `git diff` returns empty. A
      // file you just wrote is the one you most want to see: diff it against
      // nothing, as every other tool shows a new file.
      return await this.diffAgainstNothing(workspacePath, relativePath);
    } catch (error) {
      const mapped = this.mapGitError(error);
      if (!mapped.available) {
        return "";
      }
      return "";
    }
  }

  /**
   * `--no-index` diffs two paths regardless of the index and exits 1 when they
   * differ, so execFile reports failure and the diff arrives on the error.
   */
  private async diffAgainstNothing(
    workspacePath: string,
    relativePath: string
  ): Promise<string> {
    const args = [
      "-C",
      workspacePath,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-index",
      "--",
      NULL_DEVICE,
      relativePath,
    ];

    try {
      const output = await execFileAsync("git", args);
      return output.stdout ?? "";
    } catch (error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      return typeof stdout === "string" ? stdout : "";
    }
  }

  private async mergeDiffNumstat(
    stats: Map<string, GitChangeStats>,
    workspacePath: string,
    args: string[]
  ): Promise<void> {
    try {
      const output = await execFileAsync("git", ["-C", workspacePath, ...args]);

      for (const entry of parseNumstatZ(output.stdout)) {
        const previous = stats.get(entry.path);
        stats.set(entry.path, {
          additions: this.mergeStatCount(
            previous?.additions ?? null,
            entry.additions
          ),
          deletions: this.mergeStatCount(
            previous?.deletions ?? null,
            entry.deletions
          ),
        });
      }
    } catch {}
  }

  private mergeStatCount(
    left: number | null,
    right: number | null
  ): number | null {
    if (left == null) {
      return right;
    }
    if (right == null) {
      return left;
    }
    return left + right;
  }

  private mapGitError(error: unknown): GitStatusResult {
    const message = this.errorMessage(error);
    if (message.includes("not a git repository")) {
      return {
        available: false,
        changes: [],
        message: "Git is not initialized here.",
      };
    }

    if (
      message.includes("ENOENT") ||
      message.includes("not found") ||
      message.includes("command not found")
    ) {
      return {
        available: false,
        changes: [],
        message: "Git is not installed on this machine.",
      };
    }

    return {
      available: false,
      changes: [],
      message: "Unable to read git status for this workspace.",
    };
  }

  async stageFile(
    workspacePath: string,
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await execFileAsync("git", ["-C", workspacePath, "add", "--", filePath]);
      return { success: true };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  async unstageFile(
    workspacePath: string,
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await execFileAsync("git", [
        "-C",
        workspacePath,
        "restore",
        "--staged",
        "--",
        filePath,
      ]);
      return { success: true };
    } catch (error) {
      return { success: false, error: this.errorMessage(error) };
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message.toLowerCase();
    }

    if (typeof error === "object" && error != null) {
      const candidate = error as {
        stderr?: string;
        stdout?: string;
        message?: string;
      };
      return [candidate.stderr, candidate.stdout, candidate.message]
        .filter((v) => typeof v === "string")
        .join(" ")
        .toLowerCase();
    }

    return String(error).toLowerCase();
  }
}
