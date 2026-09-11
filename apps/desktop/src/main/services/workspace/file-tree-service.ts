import { execFile } from "child_process";
import type { Dirent } from "fs";
import fsp from "fs/promises";
import path from "path";
import { promisify } from "util";

import type { FileTreeNode, GitChangeItem } from "#shared/contracts";

const execFileAsync = promisify(execFile);

/**
 * Whether `candidate` really lands inside `workspace`, symlinks followed. Real
 * paths plus `path.relative` handle both case-insensitive filesystems and
 * links pointing out of the workspace, as the agent's workspace gate does.
 * Exported for workspace-containment-parity.test.ts.
 */
export async function isInsideWorkspace(
  candidate: string,
  workspace: string,
  { allowRoot = false } = {}
): Promise<boolean> {
  const fold = (p: string): string =>
    process.platform === "win32" || process.platform === "darwin"
      ? p.toLowerCase()
      : p;
  const root = await realPathOf(workspace);
  const real = await realPathOf(candidate);
  // Unresolvable: not known to be inside anything, so treated as outside.
  if (root === null || real === null) return false;
  const relative = path.relative(fold(root), fold(real));
  if (relative === "") return allowRoot;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Enough for any sane chain; past it, the path is a loop. */
const LINK_BUDGET = 40;

/**
 * Real path of something that may not exist yet: the nearest existing ancestor
 * is resolved and the missing remainder re-attached. A dangling symlink gets
 * its own step because writing it creates its TARGET, which may be outside the
 * workspace, so link components are followed by hand, chains included.
 * Returns null on a chain past the budget (a loop); callers fail closed.
 */
async function realPathOf(
  target: string,
  linkBudget: number = LINK_BUDGET
): Promise<string | null> {
  const missing: string[] = [];
  let head = path.resolve(target);
  for (;;) {
    try {
      return path.join(await fsp.realpath(head), ...missing);
    } catch {
      let link: string | null = null;
      try {
        if ((await fsp.lstat(head)).isSymbolicLink()) {
          link = await fsp.readlink(head);
        }
      } catch {
        // Truly absent, not a dangling link: keep walking up.
      }
      if (link !== null) {
        if (linkBudget <= 0) return null;
        // A relative link aims from the directory it really sits in.
        const parent = await realPathOf(path.dirname(head), linkBudget);
        if (parent === null) return null;
        const resolved = await realPathOf(
          path.resolve(parent, link),
          linkBudget - 1
        );

        return resolved === null ? null : path.join(resolved, ...missing);
      }

      const parent = path.dirname(head);
      if (parent === head) return path.resolve(target);
      missing.unshift(path.basename(head));
      head = parent;
    }
  }
}

const MAX_TREE_NODES = 5000;
const MAX_CHILDREN_PER_DIR = 400;
const GIT_LS_FILES_TIMEOUT_MS = 1200;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".svn",
  ".hg",
]);

interface TrackedDirectoryInfo {
  // Contain at least one non-ignored entry, so must stay visible.
  visibleDirectories: Set<string>;
  // Collapsed `dir/` entries from `--directory`; whole subtree non-ignored.
  untrackedRoots: Set<string>;
}

export class FileTreeService {
  private readonly nodeCache = new Map<string, FileTreeNode[]>();
  private readonly trackedDirectorySetCache = new Map<
    string,
    TrackedDirectoryInfo
  >();
  private cacheVersion = 0;

  invalidateCache(): void {
    this.cacheVersion += 1;
    this.nodeCache.clear();
    this.trackedDirectorySetCache.clear();
  }

  async buildRootTree(
    rootPath: string,
    gitChanges: GitChangeItem[]
  ): Promise<FileTreeNode[]> {
    return this.readDirectoryChildren(rootPath, rootPath, gitChanges);
  }

  async buildDirectoryChildren(
    rootPath: string,
    directoryPath: string,
    gitChanges: GitChangeItem[]
  ): Promise<FileTreeNode[]> {
    return this.readDirectoryChildren(rootPath, directoryPath, gitChanges);
  }

  async renameFile(
    workspacePath: string,
    fromPath: string,
    toPath: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const normalizedWorkspace = path.resolve(workspacePath);
      const absFrom = path.resolve(
        normalizedWorkspace,
        fromPath.replace(/\//g, path.sep)
      );
      const absTo = path.resolve(
        normalizedWorkspace,
        toPath.replace(/\//g, path.sep)
      );
      if (
        !(await isInsideWorkspace(absFrom, normalizedWorkspace)) ||
        !(await isInsideWorkspace(absTo, normalizedWorkspace))
      ) {
        return { success: false, error: "Path outside workspace" };
      }
      await fsp.rename(absFrom, absTo);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async trashFile(
    workspacePath: string,
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { shell } = await import("electron");
      const normalizedWorkspace = path.resolve(workspacePath);
      const absPath = path.resolve(
        normalizedWorkspace,
        filePath.replace(/\//g, path.sep)
      );
      if (!(await isInsideWorkspace(absPath, normalizedWorkspace))) {
        return { success: false, error: "Path outside workspace" };
      }
      await shell.trashItem(absPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async writeFile(
    workspacePath: string,
    filePath: string,
    content: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const normalizedWorkspace = path.resolve(workspacePath);
      const absPath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(normalizedWorkspace, filePath.replace(/\//g, path.sep));
      if (
        !(await isInsideWorkspace(absPath, normalizedWorkspace, {
          allowRoot: true,
        }))
      ) {
        return { success: false, error: "Path outside workspace" };
      }
      await fsp.writeFile(absPath, content, "utf8");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async saveResolvedConflict(
    workspacePath: string,
    filePath: string,
    content: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const normalizedWorkspace = path.resolve(workspacePath);
      const absPath = path.resolve(
        normalizedWorkspace,
        filePath.replace(/\//g, path.sep)
      );
      if (!(await isInsideWorkspace(absPath, normalizedWorkspace))) {
        return { success: false, error: "Path outside workspace" };
      }
      await fsp.writeFile(absPath, content, "utf8");
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private async readDirectoryChildren(
    rootPath: string,
    directoryPath: string,
    gitChanges: GitChangeItem[]
  ): Promise<FileTreeNode[]> {
    const cacheKey = `${this.cacheVersion}:${rootPath}:${directoryPath}:${this.getGitSignature(gitChanges)}`;
    const trackedDirectories = await this.getTrackedDirectories(rootPath);
    const cached = this.nodeCache.get(cacheKey);
    if (cached != null) {
      return cached;
    }

    let entries: Dirent[] = [];
    try {
      entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      // A read failure silently blanks the tree; log it.
      console.warn(
        `[file-tree] failed to read directory ${directoryPath}:`,
        error
      );
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    const changeMap = this.buildChangeMap(gitChanges);
    const dirtyDirectorySet = this.buildDirtyDirectorySet(gitChanges);
    const candidateEntries = entries
      .map((entry) => {
        const absolutePath = path.join(directoryPath, entry.name);
        const relativePath = path
          .relative(rootPath, absolutePath)
          .split(path.sep)
          .join("/");
        return { entry, absolutePath, relativePath };
      })
      .filter(({ entry, relativePath }) => {
        if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
          return false;
        }
        if (
          relativePath.length === 0 ||
          relativePath.startsWith("..") ||
          path.isAbsolute(relativePath)
        ) {
          return false;
        }
        if (entry.isDirectory() && trackedDirectories != null) {
          if (!this.isDirectoryVisible(relativePath, trackedDirectories)) {
            return false;
          }
        }
        return true;
      });

    const ignoredRelativePaths = await this.getIgnoredRelativePaths(
      rootPath,
      candidateEntries.map(({ relativePath }) => relativePath)
    );

    const nodes: FileTreeNode[] = [];
    for (const { entry, absolutePath, relativePath } of candidateEntries) {
      if (
        nodes.length >= MAX_CHILDREN_PER_DIR ||
        nodes.length >= MAX_TREE_NODES
      ) {
        break;
      }
      if (ignoredRelativePaths.has(relativePath)) {
        continue;
      }

      const isDirectory = entry.isDirectory();
      nodes.push({
        id: relativePath,
        name: entry.name,
        absolutePath,
        relativePath,
        kind: isDirectory ? "directory" : "file",
        hasChildren: isDirectory,
        gitStatus: changeMap.get(relativePath),
        gitDirtyState:
          isDirectory && dirtyDirectorySet.has(relativePath)
            ? "dirty"
            : undefined,
        children: undefined,
      });
    }

    this.nodeCache.set(cacheKey, nodes);
    return nodes;
  }

  private getGitSignature(gitChanges: GitChangeItem[]): string {
    if (gitChanges.length === 0) {
      return "clean";
    }

    return gitChanges
      .map((change) => `${change.status}:${change.path}`)
      .join("|");
  }

  private buildChangeMap(gitChanges: GitChangeItem[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const change of gitChanges) {
      map.set(change.path, change.status);
    }
    return map;
  }

  private buildDirtyDirectorySet(gitChanges: GitChangeItem[]): Set<string> {
    const dirtyDirectories = new Set<string>();
    for (const change of gitChanges) {
      const normalizedPath = change.path.replace(/\\/g, "/");
      const segments = normalizedPath
        .split("/")
        .filter((segment) => segment.length > 0);
      if (segments.length <= 1) {
        continue;
      }

      const directorySegments = segments.slice(0, -1);
      for (let index = 0; index < directorySegments.length; index += 1) {
        dirtyDirectories.add(directorySegments.slice(0, index + 1).join("/"));
      }
    }
    return dirtyDirectories;
  }

  private async getTrackedDirectories(
    rootPath: string
  ): Promise<TrackedDirectoryInfo | null> {
    const cacheKey = `${this.cacheVersion}:${rootPath}`;
    const cached = this.trackedDirectorySetCache.get(cacheKey);
    if (cached != null) {
      return cached;
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "-C",
          rootPath,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "--directory",
        ],
        { timeout: GIT_LS_FILES_TIMEOUT_MS }
      );
      const text = String(stdout ?? "");
      const info: TrackedDirectoryInfo = {
        visibleDirectories: new Set(),
        untrackedRoots: new Set(),
      };
      if (text.trim().length === 0) {
        this.trackedDirectorySetCache.set(cacheKey, info);
        return info;
      }

      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        // `--directory` collapses a fully-untracked directory into `dir/`.
        const isDirectoryEntry = line.endsWith("/");
        const normalized = line.replace(/\\/g, "/").replace(/\/$/, "");
        if (normalized.length === 0) {
          continue;
        }
        const segments = normalized.split("/");
        // Every ancestor (and a directory entry itself) holds non-ignored content.
        const visibleDepth = isDirectoryEntry
          ? segments.length
          : segments.length - 1;
        for (let index = 0; index < visibleDepth; index += 1) {
          info.visibleDirectories.add(segments.slice(0, index + 1).join("/"));
        }
        if (isDirectoryEntry) {
          info.untrackedRoots.add(normalized);
        }
      }

      this.trackedDirectorySetCache.set(cacheKey, info);
      return info;
    } catch {
      return null;
    }
  }

  private isDirectoryVisible(
    relativePath: string,
    tracked: TrackedDirectoryInfo
  ): boolean {
    if (tracked.visibleDirectories.has(relativePath)) {
      return true;
    }
    // Inside a fully-untracked subtree is itself non-ignored.
    for (const root of tracked.untrackedRoots) {
      if (relativePath === root || relativePath.startsWith(`${root}/`)) {
        return true;
      }
    }
    return false;
  }

  private async getIgnoredRelativePaths(
    rootPath: string,
    relativePaths: string[]
  ): Promise<Set<string>> {
    if (relativePaths.length === 0) {
      return new Set();
    }

    const ignoredPaths = new Set<string>();
    const batchSize = 200;
    for (let index = 0; index < relativePaths.length; index += batchSize) {
      const batch = relativePaths.slice(index, index + batchSize);
      try {
        const { stdout } = await execFileAsync("git", [
          "-C",
          rootPath,
          "check-ignore",
          "--",
          ...batch,
        ]);
        this.collectIgnoredPaths(stdout, ignoredPaths);
      } catch (error) {
        const candidate = error as { code?: number; stdout?: string | Buffer };
        if (candidate.code === 1) {
          this.collectIgnoredPaths(candidate.stdout, ignoredPaths);
          continue;
        }
        return new Set();
      }
    }

    return ignoredPaths;
  }

  private collectIgnoredPaths(
    stdout: string | Buffer | undefined,
    target: Set<string>
  ): void {
    if (stdout == null) {
      return;
    }

    const text = typeof stdout === "string" ? stdout : stdout.toString("utf8");
    if (text.length === 0) {
      return;
    }

    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      target.add(line);
    }
  }
}
