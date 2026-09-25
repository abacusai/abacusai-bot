import { randomUUID } from "crypto";
import fsp from "fs/promises";
import path from "path";

import type {
  AddWorkspaceResult,
  WorkspaceListItem,
  RelocateWorkspaceResult,
  SwitchWorkspaceResult,
  WorkspacePathStatus,
} from "#shared/contracts";

import { workspaceStore } from "../session/workspace-store";

const WORKSPACE_STORAGE_KEY = "localCode.workspaces";
const ACTIVE_WORKSPACE_STORAGE_KEY = "localCode.activeWorkspaceId";

/**
 * path.resolve collapses `..` and strips trailing separators, so "/x/y" and
 * "/x/y/" can never register as two distinct workspaces.
 */
const normalizeWorkspacePath = (workspacePath: string): string => {
  const trimmed = workspacePath.trim();
  return trimmed.length === 0 ? "" : path.resolve(trimmed);
};

export class WorkspaceService {
  private workspaces: WorkspaceListItem[] = [];
  private activeWorkspaceId: string | null = null;
  private readonly store = workspaceStore;

  initialize(): void {
    if (this.workspaces.length > 0) {
      return;
    }

    const storedWorkspaces = this.store.get(WORKSPACE_STORAGE_KEY);
    const storedActiveWorkspaceId = this.store.get(
      ACTIVE_WORKSPACE_STORAGE_KEY
    );

    const workspaces = Array.isArray(storedWorkspaces)
      ? storedWorkspaces
          .map((workspace) => this.normalizeStoredWorkspace(workspace))
          .filter(
            (workspace): workspace is WorkspaceListItem => workspace != null
          )
      : [];

    this.workspaces = workspaces;
    this.activeWorkspaceId =
      typeof storedActiveWorkspaceId === "string"
        ? storedActiveWorkspaceId
        : null;

    // Prefer a live workspace: a launch must not land the composer on a tombstone.
    const firstLive = this.workspaces.find(
      (workspace) => workspace.status !== "deleted"
    );
    if (
      this.activeWorkspaceId != null &&
      !this.workspaces.some(
        (workspace) => workspace.id === this.activeWorkspaceId
      )
    ) {
      this.activeWorkspaceId = firstLive?.id ?? null;
    }

    if (this.activeWorkspaceId == null && firstLive != null) {
      this.activeWorkspaceId = firstLive.id;
    }

    // Nothing is seeded when the registry is empty: opening in the home directory
    // would point the agent at every file the user owns without them choosing it.

    this.workspaces = this.workspaces.map((workspace) =>
      this.withActiveStatus(workspace)
    );

    this.persist();
  }

  dispose(): void {
    this.workspaces = [];
    this.activeWorkspaceId = null;
  }

  getWorkspaces(): WorkspaceListItem[] {
    return this.workspaces;
  }

  getActiveWorkspaceId(): string | null {
    return this.activeWorkspaceId;
  }

  getActiveWorkspace(): WorkspaceListItem | null {
    if (this.activeWorkspaceId == null) {
      return null;
    }
    return (
      this.workspaces.find(
        (workspace) => workspace.id === this.activeWorkspaceId
      ) ?? null
    );
  }

  getWorkspaceByPath(workspacePath: string): WorkspaceListItem | null {
    const normalized = normalizeWorkspacePath(workspacePath);
    return (
      this.workspaces.find((workspace) => workspace.path === normalized) ?? null
    );
  }

  async addWorkspace(
    workspacePath: string,
    isRemote = false,
    kind?: "auto" | "routine" | "bot"
  ): Promise<AddWorkspaceResult> {
    if (isRemote) {
      return { success: false, error: "Remote workspaces are not supported." };
    }

    const normalized = normalizeWorkspacePath(workspacePath);
    if (normalized.length === 0) {
      return { success: false, error: "Workspace path is required." };
    }

    try {
      const stat = await fsp.stat(normalized);
      if (!stat.isDirectory()) {
        return {
          success: false,
          error: "Selected workspace is not a directory.",
        };
      }
    } catch {
      return { success: false, error: "Workspace directory does not exist." };
    }

    const existing = this.workspaces.find(
      (workspace) => workspace.path === normalized
    );
    if (existing != null) {
      // Re-adding a deleted folder revives the tombstone under the same id.
      if (
        existing.status === "deleted" ||
        (kind != null && existing.kind !== kind)
      ) {
        this.workspaces = this.workspaces.map((workspace) =>
          workspace.id === existing.id
            ? {
                ...workspace,
                status:
                  workspace.status === "deleted" ? "idle" : workspace.status,
                ...(kind != null ? { kind } : {}),
              }
            : workspace
        );
      }
      this.setActiveWorkspace(existing.id);
      this.persist();
      return { success: true, workspaceId: existing.id };
    }

    const workspaceId = randomUUID();

    this.workspaces.push({
      id: workspaceId,
      label: this.workspaceLabelFromPath(normalized),
      description: normalized,
      status: "active",
      path: normalized,
      isRemote: false,
      ...(kind != null ? { kind } : {}),
    });
    this.setActiveWorkspace(workspaceId);
    this.persist();

    return { success: true, workspaceId };
  }

  async checkWorkspacePath(workspaceId: string): Promise<WorkspacePathStatus> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    const workspacePath = workspace?.path ?? null;
    if (workspace == null || workspacePath == null) {
      return { workspaceId, path: workspacePath, exists: false };
    }
    try {
      const stat = await fsp.stat(workspacePath);
      return { workspaceId, path: workspacePath, exists: stat.isDirectory() };
    } catch (error) {
      // Only ENOENT/ENOTDIR means "gone". A permission error or a stalled
      // network mount must not offer to delete the workspace.
      const code = (error as NodeJS.ErrnoException).code;
      return {
        workspaceId,
        path: workspacePath,
        exists: code !== "ENOENT" && code !== "ENOTDIR",
      };
    }
  }

  /** Repoint at another folder, keeping the id so its sessions survive. */
  async relocateWorkspace(
    workspaceId: string,
    newPath: string
  ): Promise<RelocateWorkspaceResult> {
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    if (workspace == null) {
      return { success: false, error: "Workspace not found." };
    }

    const normalized = normalizeWorkspacePath(newPath);
    if (normalized.length === 0) {
      return { success: false, error: "Workspace path is required." };
    }

    try {
      const stat = await fsp.stat(normalized);
      if (!stat.isDirectory()) {
        return {
          success: false,
          error: "Selected workspace is not a directory.",
        };
      }
    } catch {
      return { success: false, error: "Workspace directory does not exist." };
    }

    const collision = this.workspaces.find(
      (w) => w.id !== workspaceId && w.path === normalized
    );
    if (collision != null) {
      return {
        success: false,
        error: "Another workspace already uses that folder.",
      };
    }

    // The label is what chats are filed under and may be hand-renamed; keep it.
    this.workspaces = this.workspaces.map((w) =>
      w.id === workspaceId
        ? { ...w, path: normalized, description: normalized }
        : w
    );
    this.persist();
    return { success: true };
  }

  /**
   * First stage of deletion: the record stays, marked 'deleted', so its
   * sessions remain readable; only running and sending are cut off.
   */
  markDeleted(workspaceId: string): boolean {
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    if (workspace == null || workspace.status === "deleted") return false;

    this.workspaces = this.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, status: "deleted" } : w
    );

    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId =
        this.workspaces.find((w) => w.status !== "deleted")?.id ?? null;
      this.workspaces = this.workspaces.map((w) => this.withActiveStatus(w));
    }

    this.persist();
    return true;
  }

  removeWorkspace(workspaceId: string): boolean {
    const idx = this.workspaces.findIndex((w) => w.id === workspaceId);
    if (idx === -1) return false;

    this.workspaces = this.workspaces.filter((w) => w.id !== workspaceId);

    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId =
        this.workspaces.find((w) => w.status !== "deleted")?.id ?? null;
      this.workspaces = this.workspaces.map((w) => this.withActiveStatus(w));
    }

    this.persist();
    return true;
  }

  updateLabel(workspaceId: string, label: string): boolean {
    const trimmed = label.trim();
    if (trimmed.length === 0) return false;
    const workspace = this.workspaces.find((w) => w.id === workspaceId);
    if (workspace == null) return false;
    this.workspaces = this.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, label: trimmed } : w
    );
    this.persist();
    return true;
  }

  switchWorkspace(workspaceId: string): SwitchWorkspaceResult {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId);
    if (workspace == null) {
      return { success: false, error: "Workspace not found." };
    }

    this.setActiveWorkspace(workspaceId);
    this.persist();
    return { success: true };
  }

  private setActiveWorkspace(workspaceId: string): void {
    this.activeWorkspaceId = workspaceId;
    this.workspaces = this.workspaces.map((workspace) =>
      this.withActiveStatus(workspace)
    );
  }

  // A tombstone never reports 'active'; 'deleted' tells the renderer read-only.
  private withActiveStatus(workspace: WorkspaceListItem): WorkspaceListItem {
    if (workspace.status === "deleted") return workspace;
    return {
      ...workspace,
      status: workspace.id === this.activeWorkspaceId ? "active" : "idle",
    };
  }

  private workspaceLabelFromPath(workspacePath: string): string {
    const baseName = path.basename(workspacePath);
    return baseName.length > 0 ? baseName : workspacePath;
  }

  private normalizeStoredWorkspace(value: unknown): WorkspaceListItem | null {
    if (typeof value !== "object" || value == null) {
      return null;
    }

    const candidate = value as WorkspaceListItem;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.description !== "string"
    ) {
      return null;
    }

    // Normalize on load too, so "/x/y/" entries merge with their twins.
    const workspacePath = normalizeWorkspacePath(
      typeof candidate.path === "string"
        ? candidate.path
        : candidate.description
    );
    return {
      id: candidate.id,
      label:
        typeof candidate.label === "string" && candidate.label.length > 0
          ? candidate.label
          : this.workspaceLabelFromPath(workspacePath),
      description: workspacePath,
      ...(candidate.kind === "auto" ? { kind: "auto" as const } : {}),
      // Tombstones survive restarts; everything else re-derives active/idle.
      status: candidate.status === "deleted" ? "deleted" : "idle",
      path: workspacePath,
      isRemote: false,
    };
  }

  private persist(): void {
    this.store.set(WORKSPACE_STORAGE_KEY, this.workspaces);
    this.store.set(ACTIVE_WORKSPACE_STORAGE_KEY, this.activeWorkspaceId);
  }
}
