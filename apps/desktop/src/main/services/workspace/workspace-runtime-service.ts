/**
 * The live view of the active workspace: file tree + git changes, kept fresh
 * by fs watchers and a debounced, token-guarded refresh loop, with a small
 * per-workspace cache so switching back is instant.
 */
import fs from "fs";
import os from "os";
import path from "path";

import type {
  FileTreeRootSnapshot,
  GitStateSnapshot,
  IpcEvent,
  WorkspaceState,
} from "#shared/contracts";

import type { FileTreeService } from "./file-tree-service";
import type { GitService } from "./git-service";
import type { WorkspaceService } from "./workspace-service";

export type RuntimeSnapshot = {
  fileTree: WorkspaceState["fileTree"];
  gitChanges: WorkspaceState["gitChanges"];
  gitDiffHunks: string[];
  gitAvailable: boolean;
  gitStatusMessage: string;
  workspacePath: string | null;
};

const WORKSPACE_RUNTIME_CACHE_LIMIT = 6;
const LOADING_CHANGE_FILES_STATUS_MESSAGE = "Loading change files...";

/**
 * On Linux, Node emulates a recursive `fs.watch` in JS: it walks the whole
 * tree on the event loop, which in Electron is also the UI thread, so a
 * home-directory workspace freezes the app for ~10s per registration. Two
 * thousand directories registers in well under a second; anything bigger
 * gets a non-recursive root watch and relies on the other refresh triggers.
 */
const RECURSIVE_WATCH_DIRECTORY_BUDGET = 2000;

/**
 * Established by a budget-capped asynchronous walk so the probe itself never
 * stalls the loop. The home directory (or anything containing it) is refused.
 */
export const canAffordRecursiveWatch = async (
  root: string,
  budget: number = RECURSIVE_WATCH_DIRECTORY_BUDGET,
  home: string = os.homedir()
): Promise<boolean> => {
  const resolvedRoot = path.resolve(root);
  const resolvedHome = path.resolve(home);

  if (
    resolvedRoot === resolvedHome ||
    resolvedHome.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return false;
  }

  let seen = 0;
  const queue = [resolvedRoot];

  while (queue.length > 0) {
    const directory = queue.pop();

    if (directory === undefined) {
      break;
    }

    seen += 1;

    if (seen > budget) {
      return false;
    }

    let entries: fs.Dirent[];

    try {
      // Sequential reads keep the probe's own loop pressure negligible.
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        queue.push(path.join(directory, entry.name));
      }
    }
  }

  return true;
};

const cloneFileTree = (
  nodes: WorkspaceState["fileTree"]
): WorkspaceState["fileTree"] => {
  return nodes.map((node) => ({
    ...node,
    children: Array.isArray(node.children)
      ? cloneFileTree(node.children)
      : node.children,
  }));
};

const cloneRuntimeSnapshot = (snapshot: RuntimeSnapshot): RuntimeSnapshot => {
  return {
    fileTree: cloneFileTree(snapshot.fileTree),
    gitChanges: snapshot.gitChanges.map((change) => ({ ...change })),
    gitDiffHunks: [...snapshot.gitDiffHunks],
    gitAvailable: snapshot.gitAvailable,
    gitStatusMessage: snapshot.gitStatusMessage,
    workspacePath: snapshot.workspacePath,
  };
};

const buildGitChangeSectionsSnapshot = (
  gitChanges: RuntimeSnapshot["gitChanges"]
): GitStateSnapshot["gitChangeSections"] => {
  const staged = gitChanges
    .filter((change) => change.stagedStatus != null)
    .map((change) => ({
      ...change,
      status: change.stagedStatus ?? change.status,
      stagedStatus: change.stagedStatus ?? null,
      unstagedStatus: null,
    }));

  const unstaged = gitChanges
    .filter(
      (change) => change.unstagedStatus != null || change.stagedStatus == null
    )
    .map((change) => ({
      ...change,
      status: change.unstagedStatus ?? change.status,
      stagedStatus: null,
      unstagedStatus: change.unstagedStatus ?? null,
    }));

  const merged = gitChanges.map((change) => ({ ...change }));

  return { staged, unstaged, merged };
};

type WorkspaceRuntimeDeps = {
  workspaceService: WorkspaceService;
  gitService: GitService;
  fileTreeService: FileTreeService;
  emitEvent: (event: IpcEvent) => void;
};

export class WorkspaceRuntimeService {
  private activeWorkspaceWatcher: fs.FSWatcher | null = null;
  private activeGitWatcher: fs.FSWatcher | null = null;
  /** Bumped per ensureWorkspaceWatchers; stale async attaches are dropped. */
  private watcherGeneration = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  private needsRefresh = false;
  private refreshInFlight: Promise<void> | null = null;
  private lastStateSignature = "";
  private activeRequestToken = 0;
  private readonly workspaceRuntimeCache = new Map<string, RuntimeSnapshot>();

  private runtimeSnapshot: RuntimeSnapshot = {
    fileTree: [],
    gitChanges: [],
    gitDiffHunks: [],
    gitAvailable: false,
    gitStatusMessage: "No workspace selected.",
    workspacePath: null,
  };

  constructor(private readonly deps: WorkspaceRuntimeDeps) {}

  getSnapshot(): RuntimeSnapshot {
    return this.runtimeSnapshot;
  }

  stop(): void {
    this.clearWorkspaceWatchers();
    this.clearRefreshTimer();
  }

  reset(): void {
    this.runtimeSnapshot = {
      fileTree: [],
      gitChanges: [],
      gitDiffHunks: [],
      gitAvailable: false,
      gitStatusMessage: "No workspace selected.",
      workspacePath: null,
    };
    this.lastStateSignature = "";
  }

  /** Invalidate in-flight refreshes; show the switched-to workspace at once. */
  noteWorkspaceSwitched(workspaceId: string): void {
    this.activeRequestToken += 1;
    this.applyImmediateWorkspaceSnapshot(workspaceId);
  }

  getGitState(): GitStateSnapshot {
    return {
      gitChanges: this.runtimeSnapshot.gitChanges,
      gitChangeSections: buildGitChangeSectionsSnapshot(
        this.runtimeSnapshot.gitChanges
      ),
      gitAvailable: this.runtimeSnapshot.gitAvailable,
      gitStatusMessage: this.runtimeSnapshot.gitStatusMessage,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  getFileTreeRoot(): FileTreeRootSnapshot {
    return {
      fileTree: this.runtimeSnapshot.fileTree,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  ensureWorkspaceWatchers(): void {
    this.clearWorkspaceWatchers();
    const workspace = this.deps.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote) {
      return;
    }

    // Attaches asynchronously because probing the tree size must not touch the
    // loop; the generation guard drops the attach if the workspace switched.
    const generation = ++this.watcherGeneration;
    void this.attachWorkspaceWatcher(workspace.path, generation);

    try {
      const gitPath = path.join(workspace.path, ".git");
      // Bounded: .git trees stay small no matter how big the checkout is.
      this.activeGitWatcher = fs.watch(gitPath, { recursive: true }, () => {
        this.scheduleRefresh(250);
      });
      this.activeGitWatcher.on("error", () => {
        this.scheduleRefresh(250);
      });
    } catch {
      this.activeGitWatcher = null;
    }
  }

  private async attachWorkspaceWatcher(
    workspacePath: string,
    generation: number
  ): Promise<void> {
    let recursive = false;

    try {
      recursive = await canAffordRecursiveWatch(workspacePath);
    } catch {
      recursive = false;
    }

    if (generation !== this.watcherGeneration) {
      return;
    }

    try {
      this.activeWorkspaceWatcher = fs.watch(
        workspacePath,
        { recursive },
        () => {
          this.scheduleRefresh(350);
        }
      );
      this.activeWorkspaceWatcher.on("error", () => {
        this.scheduleRefresh(350);
      });
    } catch {
      this.activeWorkspaceWatcher = null;
    }
  }

  private clearWorkspaceWatchers(): void {
    // Invalidates any in-flight async attach so a dispose never gains a watcher.
    this.watcherGeneration += 1;
    this.activeWorkspaceWatcher?.close();
    this.activeWorkspaceWatcher = null;
    this.activeGitWatcher?.close();
    this.activeGitWatcher = null;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer != null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  scheduleRefresh(delayMs: number): void {
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAndEmit();
    }, delayMs);
  }

  async refreshAndEmit(): Promise<void> {
    if (this.isRefreshing) {
      this.needsRefresh = true;
      if (this.refreshInFlight != null) {
        await this.refreshInFlight;
      }
      return;
    }

    const refreshPromise = (async () => {
      this.isRefreshing = true;
      try {
        do {
          this.needsRefresh = false;
          const requestToken = this.activeRequestToken + 1;
          this.activeRequestToken = requestToken;
          this.deps.fileTreeService.invalidateCache();
          const nextRuntimeSnapshot =
            await this.refreshActiveWorkspaceState(requestToken);
          if (nextRuntimeSnapshot == null) {
            continue;
          }
          this.runtimeSnapshot = nextRuntimeSnapshot;
          const activeWorkspaceId =
            this.deps.workspaceService.getActiveWorkspaceId();
          if (activeWorkspaceId != null) {
            this.cacheWorkspaceRuntimeSnapshot(
              activeWorkspaceId,
              nextRuntimeSnapshot
            );
          }
        } while (this.needsRefresh);
        this.emitWorkspaceStateUpdatedIfChanged();
      } finally {
        this.isRefreshing = false;
      }
    })();

    this.refreshInFlight = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.refreshInFlight === refreshPromise) {
        this.refreshInFlight = null;
      }
    }
  }

  private emitWorkspaceStateUpdatedIfChanged(): void {
    const signature = JSON.stringify({
      activeWorkspaceId: this.deps.workspaceService.getActiveWorkspaceId(),
      workspaces: this.deps.workspaceService
        .getWorkspaces()
        .map((workspace) => ({
          id: workspace.id,
          label: workspace.label,
          description: workspace.description,
          status: workspace.status,
          path: workspace.path,
          isRemote: workspace.isRemote,
        })),
      fileTree: this.runtimeSnapshot.fileTree,
      gitChanges: this.runtimeSnapshot.gitChanges,
      gitAvailable: this.runtimeSnapshot.gitAvailable,
      gitStatusMessage: this.runtimeSnapshot.gitStatusMessage,
      workspacePath: this.runtimeSnapshot.workspacePath,
    });

    if (signature === this.lastStateSignature) {
      return;
    }

    this.lastStateSignature = signature;
    const emittedAt = new Date().toISOString();
    this.deps.emitEvent({
      type: "metadata-updated",
      emittedAt,
    });
    this.deps.emitEvent({
      type: "git-state-updated",
      emittedAt,
    });
    this.deps.emitEvent({
      type: "file-tree-root-updated",
      emittedAt,
    });
  }

  private cacheWorkspaceRuntimeSnapshot(
    workspaceId: string,
    snapshot: RuntimeSnapshot
  ): void {
    const nextCache = new Map(this.workspaceRuntimeCache);
    nextCache.delete(workspaceId);
    nextCache.set(workspaceId, cloneRuntimeSnapshot(snapshot));
    while (nextCache.size > WORKSPACE_RUNTIME_CACHE_LIMIT) {
      const oldestWorkspaceId = nextCache.keys().next().value;
      if (oldestWorkspaceId == null) {
        break;
      }
      nextCache.delete(oldestWorkspaceId);
    }
    this.workspaceRuntimeCache.clear();
    for (const [key, value] of nextCache.entries()) {
      this.workspaceRuntimeCache.set(key, value);
    }
  }

  private applyImmediateWorkspaceSnapshot(workspaceId: string): void {
    this.deps.fileTreeService.invalidateCache();
    const cachedSnapshot = this.workspaceRuntimeCache.get(workspaceId);
    if (cachedSnapshot != null) {
      this.runtimeSnapshot = cloneRuntimeSnapshot(cachedSnapshot);
      this.emitWorkspaceStateUpdatedIfChanged();
      return;
    }

    this.runtimeSnapshot = {
      fileTree: [],
      gitChanges: [],
      gitDiffHunks: [],
      gitAvailable: false,
      gitStatusMessage: LOADING_CHANGE_FILES_STATUS_MESSAGE,
      workspacePath:
        this.deps.workspaceService.getActiveWorkspace()?.path ?? null,
    };
    this.emitWorkspaceStateUpdatedIfChanged();
  }

  private async refreshActiveWorkspaceState(
    requestToken: number
  ): Promise<RuntimeSnapshot | null> {
    const workspace = this.deps.workspaceService.getActiveWorkspace();
    if (workspace == null) {
      return {
        fileTree: [],
        gitChanges: [],
        gitDiffHunks: [],
        gitAvailable: false,
        gitStatusMessage: "No workspace selected.",
        workspacePath: null,
      };
    }

    if (workspace.isRemote) {
      return {
        fileTree: [],
        gitChanges: [],
        gitDiffHunks: [],
        gitAvailable: false,
        gitStatusMessage: "Remote workspace is not mounted locally.",
        workspacePath: null,
      };
    }

    if (workspace.path == null) {
      return {
        fileTree: [],
        gitChanges: [],
        gitDiffHunks: [],
        gitAvailable: false,
        gitStatusMessage: "Workspace path is unavailable.",
        workspacePath: null,
      };
    }

    const gitStatus = await this.deps.gitService.readGitChanges(workspace.path);
    if (requestToken !== this.activeRequestToken) {
      return null;
    }

    this.runtimeSnapshot = {
      fileTree:
        this.runtimeSnapshot.workspacePath === workspace.path
          ? this.runtimeSnapshot.fileTree
          : [],
      gitChanges: gitStatus.changes,
      gitDiffHunks: [],
      gitAvailable: gitStatus.available,
      gitStatusMessage: gitStatus.message,
      workspacePath: workspace.path,
    };
    this.emitWorkspaceStateUpdatedIfChanged();

    const fileTree = await this.deps.fileTreeService.buildRootTree(
      workspace.path,
      gitStatus.changes
    );
    if (requestToken !== this.activeRequestToken) {
      return null;
    }

    return {
      fileTree,
      gitChanges: gitStatus.changes,
      gitDiffHunks: [],
      gitAvailable: gitStatus.available,
      gitStatusMessage: gitStatus.message,
      workspacePath: workspace.path,
    };
  }
}
