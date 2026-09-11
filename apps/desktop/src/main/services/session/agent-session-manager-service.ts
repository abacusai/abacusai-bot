import { AgentStatus } from "#shared/agent-types";
import type {
  AgentSessionListItem,
  AgentSessionSnapshot,
  RoutineRunOutcome,
  SessionOwner,
} from "#shared/contracts";

import {
  clearSessionStash,
  readSessionStash,
  writeSessionStash,
} from "./account-session-stash";
import { workspaceStore } from "./workspace-store";

type SessionRecord = {
  id: string;
  workspaceId: string;
  label: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  status: AgentSessionSnapshot["status"];
  agentStatus: AgentSessionSnapshot["agentStatus"];
  model: string | null;
  mode: AgentSessionSnapshot["mode"];
  worktreeId?: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  /** The routine whose fire minted this session, if any. */
  routineId?: string | null;
  /** For a routine run: how it went. See AgentSessionListItem.runOutcome. */
  runOutcome?: RoutineRunOutcome | null;
  /** For a routine run: what fired it. */
  runTrigger?: string | null;
  /** The routine this session edits — the editor turn behind its composer. */
  editorFor?: string | null;
  /** Minted by the bot service — a bot chat of some kind, never a session. */
  botOwned?: boolean;
  /** Parentage, stamped at mint. The one authoritative bot<->session link. */
  owner?: SessionOwner | null;
  /** The agent's own session id, and the log it writes. See recordAgentSession. */
  agentSessionId?: string;
  agentSessionFile?: string | null;
  /** Every agent session this one has opened, newest last. See recordAgentSession. */
  agentSessionIds?: string[];
};

// Persisted, so the old name stays — see workspace-store.ts.
const SESSIONS_STORAGE_KEY = "localCode.agentSessions";

const toListItem = (record: SessionRecord): AgentSessionListItem => ({
  id: record.id,
  workspaceId: record.workspaceId,
  label: record.label,
  conversationId: record.conversationId ?? null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  status: record.status,
  agentStatus: record.agentStatus,
  model: record.model,
  mode: record.mode,
  worktreeId: record.worktreeId ?? null,
  worktreePath: record.worktreePath ?? null,
  worktreeBranch: record.worktreeBranch ?? null,
  routineId: record.routineId ?? null,
  runOutcome: record.runOutcome ?? null,
  runTrigger: record.runTrigger ?? null,
  editorFor: record.editorFor ?? null,
  botOwned: record.botOwned === true || record.owner != null,
  owner: record.owner ?? null,
});

export class AgentSessionManagerService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly workspaceSessionIds = new Map<string, string[]>();
  private readonly store = workspaceStore;
  // Records whose workspace wasn't in the registry at startup. Hidden from
  // lists but written back by persist(): a momentarily wrong registry must
  // not erase sessions for good. They re-attach when the id reappears.
  private orphanedRecords: SessionRecord[] = [];

  initialize(allowedWorkspaceIds: string[]): void {
    const allowed = new Set(allowedWorkspaceIds);
    const stored = this.store.get(SESSIONS_STORAGE_KEY);
    const records: SessionRecord[] = Array.isArray(stored)
      ? stored.filter((r): r is SessionRecord => {
          if (typeof r !== "object" || r == null) return false;
          const rec = r as Record<string, unknown>;
          return (
            typeof rec.id === "string" && typeof rec.workspaceId === "string"
          );
        })
      : [];

    this.orphanedRecords = records.filter(
      (record) => !allowed.has(record.workspaceId)
    );

    for (const record of records) {
      if (!allowed.has(record.workspaceId)) continue;
      // Restore as stopped. A routine run caught mid-flight is over too:
      // nothing will ever settle it, so it is a failure.
      const restored: SessionRecord = {
        ...record,
        status: "stopped",
        ...(record.runOutcome === "running" ? { runOutcome: "failed" } : {}),
      };
      this.sessions.set(record.id, restored);
      const ids = this.workspaceSessionIds.get(record.workspaceId) ?? [];
      this.workspaceSessionIds.set(record.workspaceId, [...ids, record.id]);
    }
  }

  create(
    workspaceId: string,
    routineId: string | null = null,
    owner: SessionOwner | null = null,
    runTrigger: string | null = null
  ): AgentSessionListItem {
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const record: SessionRecord = {
      id: sessionId,
      workspaceId,
      routineId,
      // A routine's run is running from the moment it exists.
      runOutcome: routineId != null ? "running" : null,
      runTrigger: routineId != null ? runTrigger : null,
      owner,
      botOwned: owner != null,
      label: "Untitled",
      conversationId: null,
      createdAt: now,
      updatedAt: now,
      status: "stopped",
      agentStatus: AgentStatus.Idle,
      model: null,
      mode: null,
      worktreeId: null,
      worktreePath: null,
      worktreeBranch: null,
    };
    this.sessions.set(sessionId, record);
    const workspaceSessionIds = this.workspaceSessionIds.get(workspaceId) ?? [];
    this.workspaceSessionIds.set(workspaceId, [
      ...workspaceSessionIds,
      sessionId,
    ]);
    this.persist();
    return toListItem(record);
  }

  /**
   * The editor session for a routine, minted on first use and reused so the
   * model sees what it last changed. Never listed anywhere.
   */
  editorFor(routineId: string, workspaceId: string): AgentSessionListItem {
    const existing = [...this.sessions.values()].find(
      (record) => record.editorFor === routineId
    );
    if (existing != null) return toListItem(existing);
    const created = this.create(workspaceId);
    const record = this.sessions.get(created.id)!;
    record.editorFor = routineId;
    record.label = "Routine editor";
    this.persist();
    return toListItem(record);
  }

  /** A routine's runs, newest first: every fire that minted a session. */
  listByRoutine(routineId: string): AgentSessionListItem[] {
    // Insertion order is creation order, even within one millisecond.
    return [...this.sessions.values()]
      .filter((record) => record.routineId === routineId)
      .reverse()
      .map(toListItem);
  }

  /**
   * Settle a routine run. Only ever moves forward: a run that failed stays
   * failed even if a trailing idle arrives after the error.
   */
  setRunOutcome(sessionId: string, outcome: RoutineRunOutcome): void {
    const session = this.sessions.get(sessionId);
    if (session == null || session.routineId == null) return;
    if (session.runOutcome === "failed" && outcome === "completed") return;
    if (session.runOutcome === outcome) return;
    session.runOutcome = outcome;
    session.updatedAt = new Date().toISOString();
    this.persist();
  }

  /** The sessions a bot owns, straight off the records — no registry. */
  listOwnedBy(botId: string): AgentSessionListItem[] {
    return [...this.sessions.values()]
      .filter((record) => record.owner?.botId === botId)
      .map((record) => toListItem(record));
  }

  /** Bot-owned records parked as orphans — their workspace is gone. */
  ownedOrphans(): AgentSessionListItem[] {
    return this.orphanedRecords
      .filter((record) => record.owner != null)
      .map((record) => toListItem(record));
  }

  /**
   * Move a session into a workspace that exists, from a dead id or the
   * orphan pool. A bot chat whose workspace vanished belonged to an earlier
   * registration of the same folder; transcripts are keyed by session id.
   */
  rehome(sessionId: string, workspaceId: string): boolean {
    const orphanIndex = this.orphanedRecords.findIndex(
      (record) => record.id === sessionId
    );
    const record =
      orphanIndex >= 0
        ? this.orphanedRecords[orphanIndex]
        : this.sessions.get(sessionId);
    if (record == null || record.workspaceId === workspaceId) return false;

    if (orphanIndex >= 0) this.orphanedRecords.splice(orphanIndex, 1);
    else {
      const previous = this.workspaceSessionIds.get(record.workspaceId) ?? [];
      this.workspaceSessionIds.set(
        record.workspaceId,
        previous.filter((id) => id !== sessionId)
      );
    }

    const moved: SessionRecord = {
      ...record,
      workspaceId,
      status: "stopped",
    };
    this.sessions.set(sessionId, moved);
    this.workspaceSessionIds.set(workspaceId, [
      ...(this.workspaceSessionIds.get(workspaceId) ?? []),
      sessionId,
    ]);
    this.persist();
    return true;
  }

  ownerOf(sessionId: string): SessionOwner | null {
    return this.sessions.get(sessionId)?.owner ?? null;
  }

  /** A session that exists to run a routine: minted by a fire, or a bot's routine chat. */
  isRoutineSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    return record?.routineId != null || record?.owner?.role === "routine";
  }

  /** Find a bot conversation by its find-or-reuse key — registry-free. */
  findOwned(
    botId: string,
    role: SessionOwner["role"],
    key: string | null
  ): AgentSessionListItem | null {
    // Orphans included: a bot chat whose workspace left is still the bot's.
    for (const record of [...this.sessions.values(), ...this.orphanedRecords]) {
      const owner = record.owner;
      if (
        owner != null &&
        owner.botId === botId &&
        owner.role === role &&
        owner.key === key
      )
        return toListItem(record);
    }
    return null;
  }

  /** Backfill parentage onto a session minted before owners existed. */
  adoptOwner(sessionId: string, owner: SessionOwner): void {
    const record = this.sessions.get(sessionId);
    if (record == null || record.owner != null) return;
    record.owner = owner;
    record.botOwned = true;
    this.persist();
  }

  list(workspaceId: string): AgentSessionListItem[] {
    const sessionIds = this.workspaceSessionIds.get(workspaceId) ?? [];
    return sessionIds
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session): session is SessionRecord => session != null)
      .map((session) => toListItem(session))
      .sort(
        (left, right) => left.updatedAt.localeCompare(right.updatedAt) * -1
      );
  }

  // initialize() filtered to allowedWorkspaceIds and removeAllForWorkspace()
  // prunes on delete, so orphans do not leak here.
  listAll(): AgentSessionListItem[] {
    return Array.from(this.sessions.values())
      .map(toListItem)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Label and agent-log pointers for one session, for the log dump only. */
  getDiagnosticInfo(sessionId: string): {
    label: string;
    agentSessionId: string | null;
    agentSessionFile: string | null;
  } | null {
    const session = this.sessions.get(sessionId);
    if (session == null) return null;
    return {
      label: session.label,
      agentSessionId: session.agentSessionId ?? null,
      agentSessionFile: session.agentSessionFile ?? null,
    };
  }

  remove(workspaceId: string, sessionId: string): boolean {
    const existing = this.sessions.get(sessionId);
    if (existing == null || existing.workspaceId !== workspaceId) {
      return false;
    }
    this.sessions.delete(sessionId);
    const sessionIds = this.workspaceSessionIds.get(workspaceId) ?? [];
    this.workspaceSessionIds.set(
      workspaceId,
      sessionIds.filter((id) => id !== sessionId)
    );
    this.persist();
    return true;
  }

  removeAllForWorkspace(workspaceId: string): string[] {
    const sessionIds = this.workspaceSessionIds.get(workspaceId) ?? [];
    for (const sessionId of sessionIds) {
      this.sessions.delete(sessionId);
    }
    this.workspaceSessionIds.delete(workspaceId);
    if (sessionIds.length > 0) this.persist();
    return sessionIds;
  }

  get(sessionId: string): AgentSessionListItem | null {
    const session = this.sessions.get(sessionId);
    if (session == null) {
      return null;
    }
    return toListItem(session);
  }

  getConversationId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.conversationId ?? null;
  }

  updateConversationId(
    sessionId: string,
    conversationId: string | null
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (session == null) return false;
    session.conversationId = conversationId;
    this.persist();
    return true;
  }

  updateWorktree(
    workspaceId: string,
    sessionId: string,
    worktree: {
      id: string;
      path: string;
      branch: string | null;
    } | null
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (session == null || session.workspaceId !== workspaceId) return false;
    session.worktreeId = worktree?.id ?? null;
    session.worktreePath = worktree?.path ?? null;
    session.worktreeBranch = worktree?.branch ?? null;
    session.updatedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  /**
   * Pin the model this session runs on. A stopped session has no CLI state
   * to report, so without this a reopen would spawn on whatever the composer
   * last showed rather than the model the chat was using.
   */
  updateModel(sessionId: string, model: string | null): boolean {
    const session = this.sessions.get(sessionId);
    if (session == null) return false;
    if (session.model === model) return true;
    session.model = model;
    this.persist();
    return true;
  }

  updateLabel(workspaceId: string, sessionId: string, label: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session == null || session.workspaceId !== workspaceId) {
      return false;
    }
    session.label = label;
    session.updatedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  /**
   * Record which agent log belongs to this session; the two ids are unrelated
   * UUIDs. Written on every ready, since each spawn opens a new log, and
   * `agentSessionIds` keeps them all: `session_search` reads that list to tell
   * an app log from a terminal one (packages/agent/src/session-search.ts).
   */
  recordAgentSession(
    sessionId: string,
    agentSessionId: string,
    agentSessionFile: string | null
  ): void {
    const session = this.sessions.get(sessionId);
    if (session == null) {
      return;
    }
    session.agentSessionId = agentSessionId;
    session.agentSessionFile = agentSessionFile;
    const seen = session.agentSessionIds ?? [];
    // Re-recorded on every ready, and a ready can repeat without a new log.
    if (!seen.includes(agentSessionId)) {
      session.agentSessionIds = [...seen, agentSessionId];
    }
    this.persist();
  }

  updateFromCliState(state: AgentSessionSnapshot): void {
    const session = this.sessions.get(state.sessionId);
    if (session == null) {
      return;
    }
    session.status = state.status;
    session.agentStatus = state.agentStatus;
    session.model = state.model;
    session.mode = state.mode;
    session.updatedAt = new Date().toISOString();
    // Debounced: this fires on every CLI state change, many per second while
    // streaming, but a crash must not lose the latest status entirely.
    this.schedulePersist();
  }

  /**
   * Move every session record into the account's stash file. Merges by id:
   * a stash that survived a failed restore must not be overwritten. Callers
   * stop live CLIs first.
   */
  stashAll(accountKey: string): number {
    const records = [...this.sessions.values(), ...this.orphanedRecords];
    if (records.length === 0) return 0;

    const existing = readSessionStash(accountKey) as SessionRecord[];
    const byId = new Map(existing.map((record) => [record.id, record]));
    for (const record of records)
      byId.set(record.id, { ...record, status: "stopped" });
    writeSessionStash(accountKey, [...byId.values()]);

    this.sessions.clear();
    this.workspaceSessionIds.clear();
    this.orphanedRecords = [];
    this.persist();

    return records.length;
  }

  /**
   * Bring an account's stashed sessions back. Unknown workspaces park as
   * orphans, live ids are skipped, and the stash is removed only after persist.
   */
  restoreFromStash(accountKey: string, allowedWorkspaceIds: string[]): number {
    const stashed = readSessionStash(accountKey).filter(
      (r): r is SessionRecord => {
        if (typeof r !== "object" || r == null) return false;
        const rec = r as Record<string, unknown>;
        return (
          typeof rec.id === "string" && typeof rec.workspaceId === "string"
        );
      }
    );
    if (stashed.length === 0) return 0;

    const allowed = new Set(allowedWorkspaceIds);
    let restored = 0;
    for (const record of stashed) {
      if (
        this.sessions.has(record.id) ||
        this.orphanedRecords.some((orphan) => orphan.id === record.id)
      )
        continue;
      restored += 1;
      if (!allowed.has(record.workspaceId)) {
        this.orphanedRecords.push(record);
        continue;
      }
      this.sessions.set(record.id, { ...record, status: "stopped" });
      const ids = this.workspaceSessionIds.get(record.workspaceId) ?? [];
      this.workspaceSessionIds.set(record.workspaceId, [...ids, record.id]);
    }
    this.persist();
    clearSessionStash(accountKey);

    return restored;
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private schedulePersist(): void {
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 500);
  }

  private persist(): void {
    if (this.persistTimer != null) {
      // An immediate persist supersedes a pending debounced one.
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.store.set(SESSIONS_STORAGE_KEY, [
      ...this.sessions.values(),
      ...this.orphanedRecords,
    ]);
  }
}
