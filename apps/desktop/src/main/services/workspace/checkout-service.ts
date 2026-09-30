/**
 * Checkout-aware file and git operations (spec 04 §26.4 a–c, h, i). A
 * `CheckoutRef` names a workspace and optionally a session; the checkout is
 * the session's worktree when it has one, else the workspace's primary
 * checkout. Nothing here reads the legacy "active workspace": the procedures
 * without a `checkout` keep that behaviour through ServiceHost's own methods.
 *
 * It also keeps a `gitState` row, with change fingerprints, for every
 * checkout someone watches (`git.watch`), refreshed by fs watchers on the
 * checkout and its git dir and a slow poll.
 *
 * No Electron: the Trash and the search engine are injected.
 */
import { execFile } from "child_process";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { promisify } from "util";

import {
  checkoutKey,
  type CheckoutKey,
  type CheckoutRef,
  type CheckoutStatus,
  type GitDiffResult,
  type GitDiscardEntry,
  type GitDiscardResult,
} from "#shared/contract/checkout";
import type { FileSearchResult } from "#shared/contract/files";
import type { GitStateRow } from "#shared/contract/rows";
import {
  WORKSPACE_MISSING_ERROR,
  type AgentSessionListItem,
  type FileTreeNode,
  type FileTreeRootSnapshot,
  type GitChangeItem,
  type GitDiffScope,
  type WorkspaceListItem,
} from "#shared/contracts";
import { ForbiddenError } from "#shared/forbidden";
import { EntityNotFoundError, WORKSPACE_NOT_FOUND } from "#shared/not-found";

import { isMigrationWriteBlockedTree } from "../../migrations/write-block";
import { isInsideWorkspace, type FileTreeService } from "./file-tree-service";
import type { GitService } from "./git-service";
import {
  buildGitChangeSectionsSnapshot,
  canAffordRecursiveWatch,
} from "./workspace-runtime-service";

const execFileAsync = promisify(execFile);

export interface ResolvedCheckout {
  key: CheckoutKey;
  workspaceId: string;
  worktreeId: string | null;
  kind: "primary" | "worktree";
  /** The directory everything happens in. */
  path: string;
}

type Watcher = { close(): void };
export type CheckoutWatchFactory = (
  target: string,
  options: { recursive: boolean },
  onChange: () => void
) => Watcher | null;

export interface CheckoutServiceDeps {
  workspace(workspaceId: string): WorkspaceListItem | null;
  session(sessionId: string): AgentSessionListItem | null;
  git: GitService;
  /** Its own instance: the active workspace's cache is the runtime's. */
  files: FileTreeService;
  search(root: string, query: string): Promise<FileSearchResult>;
  /** The OS Trash (`shell.trashItem`). */
  trash(absolutePath: string): Promise<void>;
  /** Defaults to the migration runner's `isMigrationWriteBlockedTree`. */
  isWriteBlocked?: (absolutePath: string) => boolean;
  /** `fs.watch` by default; null disables watching (tests drive `refresh`). */
  watch?: CheckoutWatchFactory | null;
  /** Backstop re-read period of a watched checkout; null disables. */
  pollMs?: number | null;
  debounceMs?: number;
  log?: (message: string) => void;
}

interface WatchedCheckout {
  /** What the watcher asked for: re-resolved on every read (a relocation). */
  ref: CheckoutRef;
  target: ResolvedCheckout;
  count: number;
  row: GitStateRow | null;
  signature: string | null;
  stop: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  refreshing: Promise<void> | null;
  again: boolean;
}

const defaultWatch: CheckoutWatchFactory = (target, options, onChange) => {
  try {
    const watcher = fs.watch(target, { recursive: options.recursive }, () =>
      onChange()
    );
    watcher.on("error", () => onChange());
    return watcher;
  } catch {
    return null;
  }
};

const isDirectory = async (target: string | null): Promise<boolean> => {
  if (target == null) return false;
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
};

/** A checkout-relative path with forward slashes, as git reports it. */
const toRelative = (root: string, absolute: string): string =>
  path.relative(root, absolute).split(path.sep).join("/");

export class CheckoutService {
  readonly #deps: CheckoutServiceDeps;
  readonly #watched = new Map<CheckoutKey, WatchedCheckout>();
  readonly #rowListeners = new Set<() => void>();
  readonly #treeListeners = new Set<(key: CheckoutKey) => void>();
  #disposed = false;

  constructor(deps: CheckoutServiceDeps) {
    this.#deps = deps;
  }

  // ─── resolution ────────────────────────────────────────────────────────

  /**
   * The checkout a ref names. `NOT_FOUND` for an unknown workspace, or a
   * session that is unknown or in another workspace; `workspace-missing`
   * for a remote or pathless workspace.
   */
  resolve(ref: CheckoutRef): ResolvedCheckout {
    const workspace = this.#deps.workspace(ref.workspaceId);
    if (workspace == null)
      throw new EntityNotFoundError(
        "workspace",
        ref.workspaceId,
        WORKSPACE_NOT_FOUND
      );
    if (workspace.isRemote === true || workspace.path == null)
      throw new Error(
        `${WORKSPACE_MISSING_ERROR}:${workspace.path ?? workspace.label}`
      );
    if (ref.sessionId == null) return this.#primary(workspace, workspace.path);
    const session = this.#deps.session(ref.sessionId);
    if (session == null || session.workspaceId !== ref.workspaceId)
      throw new EntityNotFoundError(
        "session",
        ref.sessionId,
        "Session not found in this workspace."
      );
    if (session.worktreePath == null)
      return this.#primary(workspace, workspace.path);
    return {
      key: checkoutKey(workspace.id, session.worktreeId),
      workspaceId: workspace.id,
      worktreeId: session.worktreeId,
      kind: "worktree",
      path: session.worktreePath,
    };
  }

  #primary(workspace: WorkspaceListItem, root: string): ResolvedCheckout {
    return {
      key: checkoutKey(workspace.id, null),
      workspaceId: workspace.id,
      worktreeId: null,
      kind: "primary",
      path: root,
    };
  }

  /**
   * `candidate` (checkout-relative or absolute) as an absolute path inside
   * the checkout, symlinks followed; `FORBIDDEN {outside}` otherwise.
   */
  async #inside(
    checkout: ResolvedCheckout,
    candidate: string,
    options: { allowRoot?: boolean } = {}
  ): Promise<string> {
    // `path` treats a backslash as a separator only on Windows; elsewhere
    // it is a legal filename character (`a\b` and `a/b` are two files).
    const absolute = path.resolve(checkout.path, candidate);
    if (
      !(await isInsideWorkspace(absolute, checkout.path, {
        allowRoot: options.allowRoot === true,
      }))
    )
      throw new ForbiddenError(
        "outside",
        `${candidate} is outside the checkout`
      );
    return absolute;
  }

  // ─── files ─────────────────────────────────────────────────────────────

  async treeRoot(ref: CheckoutRef): Promise<FileTreeRootSnapshot> {
    const checkout = this.resolve(ref);
    this.#deps.files.invalidateCache();
    return {
      fileTree: await this.#deps.files.buildRootTree(
        checkout.path,
        await this.#changes(checkout)
      ),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async treeChildren(
    ref: CheckoutRef,
    directoryPath: string
  ): Promise<FileTreeNode[]> {
    const checkout = this.resolve(ref);
    const directory = await this.#inside(checkout, directoryPath, {
      allowRoot: true,
    });
    return this.#deps.files.buildDirectoryChildren(
      checkout.path,
      directory,
      await this.#changes(checkout)
    );
  }

  search(ref: CheckoutRef, query: string): Promise<FileSearchResult> {
    return this.#deps.search(this.resolve(ref).path, query);
  }

  /** The legacy result shape; the procedure unwraps it. */
  async rename(
    ref: CheckoutRef,
    fromPath: string,
    toPath: string
  ): Promise<{ success: boolean; error?: string }> {
    const checkout = this.resolve(ref);
    const from = await this.#inside(checkout, fromPath);
    const to = await this.#inside(checkout, toPath);
    const result = await this.#deps.files.renameFile(
      checkout.path,
      toRelative(checkout.path, from),
      toRelative(checkout.path, to)
    );
    if (result.success) this.#touched(checkout.key);
    return result;
  }

  async trash(
    ref: CheckoutRef,
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    const checkout = this.resolve(ref);
    const target = await this.#inside(checkout, filePath);
    const result = await this.#deps.files.trashFile(
      checkout.path,
      toRelative(checkout.path, target)
    );
    if (result.success) this.#touched(checkout.key);
    return result;
  }

  // ─── git ───────────────────────────────────────────────────────────────

  async diff(
    ref: CheckoutRef,
    filePath: string,
    scope: GitDiffScope = "unstaged"
  ): Promise<GitDiffResult> {
    const checkout = this.resolve(ref);
    const target = await this.#inside(checkout, filePath);
    return this.#deps.git.diffForPath(
      checkout.path,
      toRelative(checkout.path, target),
      scope
    );
  }

  /**
   * Every path is checked before anything changes; then the entries run
   * (see `GitService.discard`: only changes git reports at exactly the
   * named checkout-relative path, never a held migration destination).
   */
  async discard(
    ref: CheckoutRef,
    entries: GitDiscardEntry[]
  ): Promise<GitDiscardResult> {
    const checkout = this.resolve(ref);
    const relative: GitDiscardEntry[] = [];
    for (const entry of entries) {
      // A deleted file's path no longer exists; its parent must be inside.
      const target = await this.#inside(checkout, entry.path);
      const origin =
        entry.origPath == null
          ? undefined
          : await this.#inside(checkout, entry.origPath);
      relative.push({
        path: toRelative(checkout.path, target),
        ...(origin != null && { origPath: toRelative(checkout.path, origin) }),
      });
    }
    const result = await this.#deps.git.discard(
      checkout.path,
      relative,
      this.#deps.trash,
      {
        // A worktree is always its own top level; a primary may be a
        // subfolder of a repository.
        requireTopLevel: checkout.kind === "worktree",
        isBlocked: this.#deps.isWriteBlocked ?? isMigrationWriteBlockedTree,
      }
    );
    // Report what the caller named, not the normalised form.
    const named = new Map(
      relative.map((entry, index) => [entry.path, entries[index]!.path])
    );
    const renamed: GitDiscardResult = {
      discarded: result.discarded.map((item) => named.get(item) ?? item),
      failed: result.failed.map((item) => ({
        ...item,
        path: named.get(item.path) ?? item.path,
      })),
    };
    this.#touched(checkout.key);
    await this.refresh(checkout.key);
    return renamed;
  }

  /** The effective path's existence; never throws for a missing folder. */
  async status(ref: CheckoutRef): Promise<CheckoutStatus> {
    const workspace = this.#deps.workspace(ref.workspaceId);
    if (workspace == null)
      throw new EntityNotFoundError(
        "workspace",
        ref.workspaceId,
        WORKSPACE_NOT_FOUND
      );
    const workspacePath =
      workspace.isRemote === true ? null : (workspace.path ?? null);
    const workspaceExists = await isDirectory(workspacePath);
    let worktreePath: string | null = null;
    if (ref.sessionId != null) {
      const session = this.#deps.session(ref.sessionId);
      if (session == null || session.workspaceId !== ref.workspaceId)
        throw new EntityNotFoundError(
          "session",
          ref.sessionId,
          "Session not found in this workspace."
        );
      worktreePath = session.worktreePath;
    }
    if (worktreePath != null)
      return {
        kind: "worktree",
        path: worktreePath,
        exists: await isDirectory(worktreePath),
        workspaceExists,
      };
    return {
      kind: "primary",
      path: workspacePath ?? "",
      exists: workspaceExists,
      workspaceExists,
    };
  }

  // ─── watched checkouts' gitState rows ──────────────────────────────────

  /**
   * Keeps the checkout's row computed until `release` (reference counted per
   * checkout key). The first row arrives after its first read.
   */
  watch(ref: CheckoutRef): { key: CheckoutKey; release: () => void } {
    const target = this.resolve(ref);
    let entry = this.#watched.get(target.key);
    if (entry != null && entry.target.path !== target.path) {
      this.#retarget(entry, target);
      void this.refresh(target.key);
    }
    if (entry == null) {
      entry = {
        ref: {
          workspaceId: ref.workspaceId,
          ...(ref.sessionId != null && { sessionId: ref.sessionId }),
        },
        target,
        count: 0,
        row: null,
        signature: null,
        stop: () => undefined,
        timer: null,
        refreshing: null,
        again: false,
      };
      this.#watched.set(target.key, entry);
      entry.stop = this.#startWatching(entry);
      void this.refresh(target.key);
    }
    entry.count += 1;
    let released = false;
    const key = target.key;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#watched.get(key);
        if (current == null) return;
        current.count -= 1;
        if (current.count > 0) return;
        this.#unwatch(key, current);
      },
    };
  }

  /** The watched checkouts' current rows (those read at least once). */
  rows(): GitStateRow[] {
    return [...this.#watched.values()]
      .map((entry) => entry.row)
      .filter((row): row is GitStateRow => row != null);
  }

  onRowsChanged(listener: () => void): () => void {
    this.#rowListeners.add(listener);
    return () => {
      this.#rowListeners.delete(listener);
    };
  }

  /** A watched checkout's tree may have changed: `files.events`. */
  onTreeChanged(listener: (key: CheckoutKey) => void): () => void {
    this.#treeListeners.add(listener);
    return () => {
      this.#treeListeners.delete(listener);
    };
  }

  /** Re-read a watched checkout's state now (one read at a time per key). */
  async refresh(key: CheckoutKey): Promise<void> {
    const entry = this.#watched.get(key);
    if (entry == null) return;
    if (entry.refreshing != null) {
      entry.again = true;
      return entry.refreshing;
    }
    entry.refreshing = (async () => {
      try {
        do {
          entry.again = false;
          await this.#read(entry);
        } while (entry.again && this.#watched.get(key) === entry);
      } finally {
        entry.refreshing = null;
      }
    })();
    return entry.refreshing;
  }

  dispose(): void {
    this.#disposed = true;
    for (const [key, entry] of this.#watched) this.#unwatch(key, entry, false);
    this.#rowListeners.clear();
    this.#treeListeners.clear();
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /** A watched checkout's latest changes, or a fresh read. */
  async #changes(checkout: ResolvedCheckout): Promise<GitChangeItem[]> {
    const watched = this.#watched.get(checkout.key)?.row;
    if (watched != null) return watched.gitChanges;
    return (
      await this.#deps.git.readGitChanges(checkout.path, {
        checkoutRelative: true,
      })
    ).changes;
  }

  /**
   * The folder moved (a relocated workspace, a re-created worktree) under
   * the same key: watch the new one and publish its path.
   */
  #retarget(entry: WatchedCheckout, target: ResolvedCheckout): void {
    entry.stop();
    entry.target = target;
    entry.signature = null;
    entry.stop = this.#startWatching(entry);
    this.#touched(target.key);
  }

  async #read(entry: WatchedCheckout): Promise<void> {
    try {
      const current = this.resolve(entry.ref);
      if (
        current.key === entry.target.key &&
        current.path !== entry.target.path
      )
        this.#retarget(entry, current);
    } catch {
      // Gone or pathless: keep the last target until the watcher releases.
    }
    const { target } = entry;
    const status = await this.#deps.git.readGitChanges(target.path, {
      fingerprints: true,
      checkoutRelative: true,
    });
    if (this.#watched.get(target.key) !== entry) return;
    const row: GitStateRow = {
      gitChanges: status.changes,
      gitChangeSections: buildGitChangeSectionsSnapshot(status.changes),
      gitAvailable: status.available,
      gitStatusMessage: status.message,
      lastUpdatedAt: new Date().toISOString(),
      workspaceId: target.workspaceId,
      checkoutKey: target.key,
      checkoutPath: target.path,
    };
    const { lastUpdatedAt: _stamp, ...compared } = row;
    const signature = JSON.stringify(compared);
    if (signature === entry.signature) return;
    entry.signature = signature;
    entry.row = row;
    this.#emitRows();
  }

  #touched(key: CheckoutKey): void {
    if (!this.#watched.has(key)) return;
    this.#deps.files.invalidateCache();
    for (const listener of Array.from(this.#treeListeners)) listener(key);
  }

  #schedule(entry: WatchedCheckout): void {
    if (entry.timer != null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.#touched(entry.target.key);
      void this.refresh(entry.target.key);
    }, this.#deps.debounceMs ?? 250);
    entry.timer.unref?.();
  }

  #startWatching(entry: WatchedCheckout): () => void {
    const watch =
      this.#deps.watch === undefined ? defaultWatch : this.#deps.watch;
    const watchers: Watcher[] = [];
    let stopped = false;
    const onChange = (): void => {
      if (!stopped) this.#schedule(entry);
    };
    if (watch != null) {
      void (async () => {
        const root = entry.target.path;
        const [recursive, gitDir] = await Promise.all([
          canAffordRecursiveWatch(root).catch(() => false),
          this.#gitDir(root),
        ]);
        if (stopped) return;
        const tree = watch(root, { recursive }, onChange);
        if (tree != null) watchers.push(tree);
        if (gitDir != null) {
          // Index, HEAD and the reflog a commit writes live in the git dir
          // (a worktree's own, under the common dir's `worktrees/`).
          const git = watch(gitDir, { recursive: true }, onChange);
          if (git != null) watchers.push(git);
        }
      })();
    }
    const pollMs = this.#deps.pollMs === undefined ? 5_000 : this.#deps.pollMs;
    const poll =
      pollMs == null
        ? null
        : setInterval(() => void this.refresh(entry.target.key), pollMs);
    poll?.unref?.();
    return () => {
      stopped = true;
      if (poll != null) clearInterval(poll);
      for (const watcher of watchers.splice(0)) watcher.close();
    };
  }

  async #gitDir(root: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", [
        "-C",
        root,
        "rev-parse",
        "--absolute-git-dir",
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  #unwatch(key: CheckoutKey, entry: WatchedCheckout, emit = true): void {
    this.#watched.delete(key);
    entry.stop();
    if (entry.timer != null) clearTimeout(entry.timer);
    entry.timer = null;
    if (emit && entry.row != null && !this.#disposed) this.#emitRows();
  }

  #emitRows(): void {
    for (const listener of Array.from(this.#rowListeners)) {
      try {
        listener();
      } catch (error) {
        (this.#deps.log ?? console.error)(
          `[checkouts] row listener threw: ${String(error)}`
        );
      }
    }
  }
}
