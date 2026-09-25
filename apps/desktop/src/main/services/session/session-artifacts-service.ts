import fs from "fs";

import type { SessionArtifact } from "#shared/contracts";

import { extractArtifacts } from "./session-artifacts.utils";
import { workspaceStore } from "./workspace-store";

const ARTIFACTS_STORAGE_KEY = "localCode.sessionArtifacts";

/** Oldest entries are dropped past this; the list is not an audit log. */
const MAX_ARTIFACTS = 2000;

// Writes and change notifications are coalesced over this window: a turn that
// edits thirty files must not rewrite the store and wake the renderer thirty
// times.
const COALESCE_MS = 250;

/**
 * The session -> artifacts ledger behind the Artifacts view. Fed off the
 * agent's NDJSON stream rather than the transcript, which does not survive a
 * restart. What counts lives in `session-artifacts.utils`; this stores,
 * dedupes, and prunes.
 */
export class SessionArtifactsService {
  private artifacts: SessionArtifact[] = [];
  private readonly store = workspaceStore;
  private persistTimer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      resolveWorkspacePath: (workspaceId: string) => string | null;
      /** Remote workspaces have no host paths to record. See recordFromNdjson. */
      isWorkspaceRemote: (workspaceId: string) => boolean;
      onChanged: () => void;
    }
  ) {}

  initialize(allowedWorkspaceIds: string[]): void {
    const allowed = new Set(allowedWorkspaceIds);
    const stored = this.store.get(ARTIFACTS_STORAGE_KEY);
    this.artifacts = Array.isArray(stored)
      ? stored
          .map((entry) => this.normalizeStored(entry))
          .filter(
            (entry): entry is SessionArtifact =>
              entry != null && allowed.has(entry.workspaceId)
          )
      : [];
  }

  /**
   * The artifacts that still exist, newest first. One `existsSync` per file
   * is fine here: `list` runs on an IPC request, not the event path.
   */
  list(): SessionArtifact[] {
    return this.artifacts
      .filter(
        (artifact) => artifact.kind === "link" || this.exists(artifact.location)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private exists(location: string): boolean {
    try {
      return fs.existsSync(location);
    } catch {
      // A path we cannot stat (permission wall, dead mount) is not worth a row.
      return false;
    }
  }

  removeForSession(sessionId: string): void {
    const next = this.artifacts.filter(
      (artifact) => artifact.sessionId !== sessionId
    );
    if (next.length === this.artifacts.length) return;
    this.artifacts = next;
    this.persist();
    this.deps.onChanged();
  }

  removeForWorkspace(workspaceId: string): void {
    const next = this.artifacts.filter(
      (artifact) => artifact.workspaceId !== workspaceId
    );
    if (next.length === this.artifacts.length) return;
    this.artifacts = next;
    this.persist();
    this.deps.onChanged();
  }

  /**
   * Record anything one agent NDJSON message produced. Hot path: a message
   * that is not a settled tool call costs two property reads and returns.
   */
  recordFromNdjson(
    workspaceId: string,
    sessionId: string,
    payload: unknown
  ): void {
    // A remote workspace's tool paths are guest paths; an absolute one would be
    // stored verbatim as a host row that cannot open. Record nothing instead.
    if (this.deps.isWorkspaceRemote(workspaceId)) return;

    const drafts = extractArtifacts(
      payload,
      this.deps.resolveWorkspacePath(workspaceId)
    );
    if (drafts.length === 0) return;

    const now = new Date().toISOString();
    let changed = false;

    for (const draft of drafts) {
      const location =
        draft.kind === "link" ? draft.location : this.canonical(draft.location);
      const id = `${sessionId}::${location}`;
      const existingIndex = this.artifacts.findIndex(
        (artifact) => artifact.id === id
      );

      if (existingIndex >= 0) {
        // Same file touched twice in one session is one artifact, freshly stamped.
        this.artifacts[existingIndex] = {
          ...this.artifacts[existingIndex],
          ...draft,
          location,
          updatedAt: now,
        };
      } else {
        this.artifacts.push({
          ...draft,
          location,
          id,
          workspaceId,
          sessionId,
          createdAt: now,
          updatedAt: now,
        });
        if (this.artifacts.length > MAX_ARTIFACTS) {
          // Pruned by age, not insertion order: slicing as stored would drop
          // the entry touched a second ago and keep one from last month.
          this.artifacts = this.artifacts
            .sort((left, right) =>
              left.updatedAt.localeCompare(right.updatedAt)
            )
            .slice(this.artifacts.length - MAX_ARTIFACTS);
        }
      }
      changed = true;
    }

    if (!changed) return;
    this.schedulePersist();
    this.scheduleChanged();
  }

  /**
   * The path with symlinks resolved, so `/tmp/x` and `/private/tmp/x` are one
   * row. A path that does not exist yet keeps the string it came with.
   */
  private canonical(location: string): string {
    try {
      return fs.realpathSync.native(location);
    } catch {
      return location;
    }
  }

  private normalizeStored(value: unknown): SessionArtifact | null {
    if (typeof value !== "object" || value == null) return null;
    const candidate = value as Record<string, unknown>;
    const {
      id,
      workspaceId,
      sessionId,
      kind,
      title,
      location,
      toolName,
      createdAt,
      updatedAt,
    } = candidate;
    if (
      typeof id !== "string" ||
      typeof workspaceId !== "string" ||
      typeof sessionId !== "string" ||
      typeof location !== "string" ||
      (kind !== "file" && kind !== "image" && kind !== "link")
    ) {
      return null;
    }
    return {
      id,
      workspaceId,
      sessionId,
      kind,
      title: typeof title === "string" && title.length > 0 ? title : location,
      location,
      toolName: typeof toolName === "string" ? toolName : "",
      createdAt:
        typeof createdAt === "string" ? createdAt : new Date(0).toISOString(),
      updatedAt:
        typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
    };
  }

  /** Write now, cancelling any pending coalesced write. */
  private persist(): void {
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.store.set(ARTIFACTS_STORAGE_KEY, this.artifacts);
  }

  private schedulePersist(): void {
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store.set(ARTIFACTS_STORAGE_KEY, this.artifacts);
    }, COALESCE_MS);
  }

  private scheduleChanged(): void {
    if (this.notifyTimer != null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.deps.onChanged();
    }, COALESCE_MS);
  }

  /** Write anything still coalesced; on shutdown there is no renderer left. */
  dispose(): void {
    if (this.notifyTimer != null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.persist();
  }
}
