/**
 * Which agent logs a conversation owns.
 *
 * The agent process is respawned on every app launch and opens a fresh log, so
 * one conversation on screen accumulates several over its life. Only the newest
 * used to be recorded, which was fine while this was diagnostic bookkeeping and
 * stopped being fine when `session_search` started using it to tell the app's
 * own logs apart from a terminal session's: every log but the latest came back
 * as a separate conversation that had said exactly the same things.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

const stored = new Map<string, unknown>();

vi.mock("./workspace-store", () => ({
  workspaceStore: {
    get: (key: string) => stored.get(key),
    set: (key: string, value: unknown) => stored.set(key, value),
  },
}));

const { AgentSessionManagerService } =
  await import("./agent-session-manager-service");

const WORKSPACE = "ws-1";

type StoredSession = {
  id: string;
  workspaceId?: string;
  label?: string;
  status?: string;
  model?: string | null;
  updatedAt?: string;
  agentSessionId?: string;
  agentSessionIds?: string[];
  worktreeId?: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
};

/** A stored record, in the shape initialize() expects to read back. */
const record = (
  over: Partial<StoredSession> & { id: string }
): Record<string, unknown> => ({
  workspaceId: WORKSPACE,
  label: "Untitled",
  conversationId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "running",
  agentStatus: "idle",
  model: null,
  mode: null,
  ...over,
});

const readStored = (): StoredSession[] =>
  (stored.get("localCode.agentSessions") ?? []) as StoredSession[];

let service: InstanceType<typeof AgentSessionManagerService>;
let home: string;

beforeEach(() => {
  stored.clear();
  // The stash files live under abacusBotHome(); give each test its own.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-test-"));
  process.env.ABACUSAI_BOT_HOME = home;
  service = new AgentSessionManagerService();
  service.initialize([WORKSPACE]);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the session list itself", () => {
  it("creates a session in its workspace and hands back what the UI shows", () => {
    const created = service.create(WORKSPACE);

    expect(created).toMatchObject({
      workspaceId: WORKSPACE,
      label: "Untitled",
      conversationId: null,
      model: null,
    });
    expect(service.list(WORKSPACE).map((item) => item.id)).toEqual([
      created.id,
    ]);
    expect(service.get(created.id)).toMatchObject({ id: created.id });
  });

  it("reports no log yet for a session whose agent has never started", () => {
    const session = service.create(WORKSPACE);

    expect(service.getDiagnosticInfo(session.id)).toEqual({
      label: "Untitled",
      agentSessionId: null,
      agentSessionFile: null,
    });
  });

  it("has nothing to say about a session it does not hold", () => {
    expect(service.get("missing")).toBeNull();
    expect(service.getDiagnosticInfo("missing")).toBeNull();
    expect(service.getConversationId("missing")).toBeNull();
    expect(service.updateConversationId("missing", "c1")).toBe(false);
    expect(service.updateModel("missing", "m")).toBe(false);
    expect(service.updateLabel(WORKSPACE, "missing", "x")).toBe(false);
    expect(service.remove(WORKSPACE, "missing")).toBe(false);
    expect(service.list("no-such-workspace")).toEqual([]);
  });

  it("lists most recently touched first, in one workspace and across all of them", () => {
    stored.set("localCode.agentSessions", [
      record({ id: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
      record({ id: "new", updatedAt: "2026-06-01T00:00:00.000Z" }),
      record({
        id: "other-ws",
        workspaceId: "ws-2",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    ]);
    const loaded = new AgentSessionManagerService();
    loaded.initialize([WORKSPACE, "ws-2"]);

    expect(loaded.list(WORKSPACE).map((item) => item.id)).toEqual([
      "new",
      "old",
    ]);
    expect(loaded.listAll().map((item) => item.id)).toEqual([
      "new",
      "other-ws",
      "old",
    ]);
  });

  it("restores a session as stopped, because its agent died with the app", () => {
    stored.set("localCode.agentSessions", [
      record({ id: "s1", status: "running" }),
    ]);
    const loaded = new AgentSessionManagerService();
    loaded.initialize([WORKSPACE]);

    expect(loaded.get("s1")?.status).toBe("stopped");
  });

  it("ignores stored junk rather than failing to start", () => {
    stored.set("localCode.agentSessions", [
      null,
      "nope",
      42,
      { noId: true },
      { id: 5, workspaceId: WORKSPACE },
      record({ id: "good" }),
    ]);
    const loaded = new AgentSessionManagerService();
    loaded.initialize([WORKSPACE]);

    expect(loaded.listAll().map((item) => item.id)).toEqual(["good"]);
  });

  it("starts empty when the store holds something that is not a list", () => {
    stored.set("localCode.agentSessions", { not: "an array" });
    const loaded = new AgentSessionManagerService();
    loaded.initialize([WORKSPACE]);

    expect(loaded.listAll()).toEqual([]);
  });

  it("removes a session, but only from the workspace that owns it", () => {
    const session = service.create(WORKSPACE);

    expect(service.remove("someone-elses-workspace", session.id)).toBe(false);
    expect(service.remove(WORKSPACE, session.id)).toBe(true);
    expect(service.list(WORKSPACE)).toEqual([]);
    expect(readStored()).toEqual([]);
  });

  it("removes every session in a workspace and says which they were", () => {
    const first = service.create(WORKSPACE);
    const second = service.create(WORKSPACE);

    expect(service.removeAllForWorkspace(WORKSPACE).sort()).toEqual(
      [first.id, second.id].sort()
    );
    expect(service.listAll()).toEqual([]);
    // A workspace with nothing in it is not a change worth writing.
    expect(service.removeAllForWorkspace("empty-workspace")).toEqual([]);
  });
});

describe("sessions filed under a workspace that is not there", () => {
  it("are hidden but not thrown away, so a bad registry is survivable", () => {
    stored.set("localCode.agentSessions", [
      record({ id: "kept", workspaceId: "vanished-workspace" }),
      record({ id: "shown" }),
    ]);
    const loaded = new AgentSessionManagerService();
    loaded.initialize([WORKSPACE]);

    expect(loaded.listAll().map((item) => item.id)).toEqual(["shown"]);

    // Still written back, so the next launch can re-attach them.
    loaded.updateLabel(WORKSPACE, "shown", "renamed");
    expect(
      readStored()
        .map((entry) => entry.id)
        .sort()
    ).toEqual(["kept", "shown"]);
  });
});

describe("changing a session", () => {
  it("renames it, but only through the workspace that owns it", () => {
    const session = service.create(WORKSPACE);

    expect(
      service.updateLabel("someone-elses-workspace", session.id, "nope")
    ).toBe(false);
    expect(service.updateLabel(WORKSPACE, session.id, "a better name")).toBe(
      true
    );
    expect(service.get(session.id)?.label).toBe("a better name");
  });

  it("pins the model, and writes nothing when it has not changed", () => {
    const session = service.create(WORKSPACE);
    service.updateModel(session.id, "abacus/some-model");
    stored.delete("localCode.agentSessions");

    // Already on that model: still true, but nothing to write.
    expect(service.updateModel(session.id, "abacus/some-model")).toBe(true);
    expect(stored.has("localCode.agentSessions")).toBe(false);
  });

  it("carries a conversation id back and forth, including clearing it", () => {
    const session = service.create(WORKSPACE);

    expect(service.updateConversationId(session.id, "conv-1")).toBe(true);
    expect(service.getConversationId(session.id)).toBe("conv-1");
    expect(service.updateConversationId(session.id, null)).toBe(true);
    expect(service.getConversationId(session.id)).toBeNull();
  });

  it("persists a workspace-scoped worktree association and can return to the main checkout", () => {
    const session = service.create(WORKSPACE);

    expect(
      service.updateWorktree("someone-elses-workspace", session.id, {
        id: "wrong",
        path: "/tmp/wrong",
        branch: "wrong",
      })
    ).toBe(false);
    expect(
      service.updateWorktree(WORKSPACE, session.id, {
        id: "wt-1",
        path: "/tmp/worktree-1",
        branch: "feature/one",
      })
    ).toBe(true);
    expect(service.get(session.id)).toMatchObject({
      worktreeId: "wt-1",
      worktreePath: "/tmp/worktree-1",
      worktreeBranch: "feature/one",
    });
    expect(readStored()[0]).toMatchObject({
      worktreeId: "wt-1",
      worktreePath: "/tmp/worktree-1",
      worktreeBranch: "feature/one",
    });

    expect(service.updateWorktree(WORKSPACE, session.id, null)).toBe(true);
    expect(service.get(session.id)).toMatchObject({
      worktreeId: null,
      worktreePath: null,
      worktreeBranch: null,
    });
  });
});

describe("state streaming in from a running agent", () => {
  it("is written, but not on every keystroke of it", () => {
    vi.useFakeTimers();
    const session = service.create(WORKSPACE);
    stored.delete("localCode.agentSessions");

    for (const status of ["running", "running", "stopped"] as const) {
      service.updateFromCliState({
        sessionId: session.id,
        status,
        agentStatus: "idle",
        model: "m",
        mode: "YOLO",
      } as never);
    }

    // Debounced: nothing on disk yet, however many updates arrived.
    expect(stored.has("localCode.agentSessions")).toBe(false);

    vi.advanceTimersByTime(500);

    expect(readStored()[0]).toMatchObject({ status: "stopped", model: "m" });
  });

  it("is superseded by a write that cannot wait", () => {
    vi.useFakeTimers();
    const session = service.create(WORKSPACE);
    service.updateFromCliState({
      sessionId: session.id,
      status: "running",
      agentStatus: "idle",
      model: "m",
      mode: "YOLO",
    } as never);
    service.updateLabel(WORKSPACE, session.id, "renamed");

    expect(readStored()[0]).toMatchObject({ label: "renamed", model: "m" });

    // The pending timer must not fire a second write after that.
    const writes = readStored();
    vi.advanceTimersByTime(1000);
    expect(readStored()).toEqual(writes);
  });

  it("ignores state for a session it does not hold", () => {
    expect(() =>
      service.updateFromCliState({
        sessionId: "missing",
        status: "running",
        agentStatus: "idle",
        model: null,
        mode: null,
      } as never)
    ).not.toThrow();
  });
});

describe("recording the log a session is writing", () => {
  it("keeps every log the session has opened, newest last", () => {
    const session = service.create(WORKSPACE);

    service.recordAgentSession(session.id, "log-1", "/logs/log-1.jsonl");
    service.recordAgentSession(session.id, "log-2", "/logs/log-2.jsonl");

    expect(readStored()[0]?.agentSessionIds).toEqual(["log-1", "log-2"]);
  });

  it("still points at the newest one, which is what a bug report needs", () => {
    const session = service.create(WORKSPACE);

    service.recordAgentSession(session.id, "log-1", "/logs/log-1.jsonl");
    service.recordAgentSession(session.id, "log-2", "/logs/log-2.jsonl");

    expect(service.getDiagnosticInfo(session.id)).toMatchObject({
      agentSessionId: "log-2",
      agentSessionFile: "/logs/log-2.jsonl",
    });
  });

  it("does not record the same log twice when ready fires again", () => {
    // A session can report ready more than once without opening a new log.
    const session = service.create(WORKSPACE);

    service.recordAgentSession(session.id, "log-1", "/logs/log-1.jsonl");
    service.recordAgentSession(session.id, "log-1", "/logs/log-1.jsonl");

    expect(readStored()[0]?.agentSessionIds).toEqual(["log-1"]);
  });

  it("keeps the list across a restart, or the older logs go unclaimed again", () => {
    const session = service.create(WORKSPACE);
    service.recordAgentSession(session.id, "log-1", "/logs/log-1.jsonl");
    service.recordAgentSession(session.id, "log-2", "/logs/log-2.jsonl");

    const restarted = new AgentSessionManagerService();
    restarted.initialize([WORKSPACE]);
    restarted.recordAgentSession(session.id, "log-3", "/logs/log-3.jsonl");

    expect(readStored()[0]?.agentSessionIds).toEqual([
      "log-1",
      "log-2",
      "log-3",
    ]);
  });

  it("starts the list for a session stored before the list existed", () => {
    stored.set("localCode.agentSessions", [
      {
        id: "old-session",
        workspaceId: WORKSPACE,
        label: "from an older build",
        conversationId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "stopped",
        agentStatus: "idle",
        model: null,
        mode: "YOLO",
        agentSessionId: "log-1",
      },
    ]);
    const upgraded = new AgentSessionManagerService();
    upgraded.initialize([WORKSPACE]);

    upgraded.recordAgentSession("old-session", "log-2", "/logs/log-2.jsonl");

    // `log-1` is not recovered — nothing recorded it as a list. It stays
    // claimed through `agentSessionId`, which search reads as well.
    expect(readStored()[0]?.agentSessionIds).toEqual(["log-2"]);
    expect(readStored()[0]?.agentSessionId).toBe("log-2");
  });

  it("ignores a session it has never heard of", () => {
    service.recordAgentSession("not-a-session", "log-1", "/logs/log-1.jsonl");

    expect(readStored()).toEqual([]);
  });
});

describe("the per-account session stash", () => {
  it("moves every session out on sign-out and brings it back on sign-in", () => {
    const created = service.create(WORKSPACE);

    expect(service.stashAll("acct-1")).toBe(1);
    expect(service.list(WORKSPACE)).toEqual([]);
    expect(readStored()).toEqual([]);

    expect(service.restoreFromStash("acct-1", [WORKSPACE])).toBe(1);
    expect(service.list(WORKSPACE).map((item) => item.id)).toEqual([
      created.id,
    ]);
    // The stash was consumed: restoring again finds nothing.
    expect(service.restoreFromStash("acct-1", [WORKSPACE])).toBe(0);
  });

  it("keeps accounts apart: one account's stash is invisible to another", () => {
    service.create(WORKSPACE);
    service.stashAll("acct-1");

    expect(service.restoreFromStash("acct-2", [WORKSPACE])).toBe(0);
    expect(service.list(WORKSPACE)).toEqual([]);

    expect(service.restoreFromStash("acct-1", [WORKSPACE])).toBe(1);
  });

  it("merges a second sign-out into the same account's stash", () => {
    const first = service.create(WORKSPACE);
    service.stashAll("acct-1");
    const second = service.create(WORKSPACE);
    service.stashAll("acct-1");

    expect(service.restoreFromStash("acct-1", [WORKSPACE])).toBe(2);
    expect(
      service
        .list(WORKSPACE)
        .map((item) => item.id)
        .toSorted()
    ).toEqual([first.id, second.id].toSorted());
  });

  it("stamps and persists the routine that minted a session", () => {
    const run = service.create(WORKSPACE, "routine-1");
    const plain = service.create(WORKSPACE);

    const listed = service.list(WORKSPACE);
    expect(listed.find((item) => item.id === run.id)?.routineId).toBe(
      "routine-1"
    );
    expect(listed.find((item) => item.id === plain.id)?.routineId).toBeNull();

    // The renderer's read-only treatment must survive a restart.
    const fresh = new AgentSessionManagerService();
    fresh.initialize([WORKSPACE]);
    expect(
      fresh.list(WORKSPACE).find((item) => item.id === run.id)?.routineId
    ).toBe("routine-1");
  });

  // A routine's runs are its record: each fire is a session, listed newest
  // first with how it went, and a run the app died in the middle of is a
  // failure, not a run still going.
  it("lists a routine's runs newest first, settling each once", () => {
    const first = service.create(WORKSPACE, "routine-1", null, "schedule");
    const second = service.create(WORKSPACE, "routine-1", null, "manual");
    service.create(WORKSPACE, "routine-2");
    service.create(WORKSPACE);

    const runs = service.listByRoutine("routine-1");
    expect(runs.map((run) => run.id)).toEqual([second.id, first.id]);
    expect(runs.map((run) => run.runOutcome)).toEqual(["running", "running"]);
    expect(runs[1]?.runTrigger).toBe("schedule");

    service.setRunOutcome(first.id, "completed");
    service.setRunOutcome(second.id, "failed");
    // A trailing idle after an error does not un-fail the run.
    service.setRunOutcome(second.id, "completed");
    expect(
      service.listByRoutine("routine-1").map((run) => run.runOutcome)
    ).toEqual(["failed", "completed"]);

    // Not a run: nothing to settle, nothing stamped.
    const plain = service.create(WORKSPACE);
    service.setRunOutcome(plain.id, "completed");
    expect(
      service.list(WORKSPACE).find((s) => s.id === plain.id)?.runOutcome
    ).toBeNull();
  });

  it("keeps one editor session per routine, off every list", () => {
    const first = service.editorFor("routine-1", WORKSPACE);
    const again = service.editorFor("routine-1", WORKSPACE);
    expect(again.id).toBe(first.id);
    expect(first.editorFor).toBe("routine-1");
    // Not a run of the routine, and not a plain session either.
    expect(service.listByRoutine("routine-1")).toEqual([]);
    expect(
      service.list(WORKSPACE).find((s) => s.id === first.id)?.editorFor
    ).toBe("routine-1");
  });

  it("marks a run the app restarted through as failed", () => {
    const run = service.create(WORKSPACE, "routine-1");
    const fresh = new AgentSessionManagerService();
    fresh.initialize([WORKSPACE]);
    expect(fresh.listByRoutine("routine-1")[0]?.id).toBe(run.id);
    expect(fresh.listByRoutine("routine-1")[0]?.runOutcome).toBe("failed");
  });

  it("stamps bot-owned sessions, and the stamp survives a restart", () => {
    const owned = service.create(WORKSPACE, null, {
      kind: "bot",
      botId: "bot-1",
      role: "forever",
      key: null,
    });
    const plain = service.create(WORKSPACE);

    const fresh = new AgentSessionManagerService();
    fresh.initialize([WORKSPACE]);
    const listed = fresh.list(WORKSPACE);
    expect(listed.find((item) => item.id === owned.id)?.botOwned).toBe(true);
    expect(listed.find((item) => item.id === plain.id)?.botOwned).toBe(false);
  });

  it("re-homes an orphaned bot chat into a workspace that exists", () => {
    // The bot folder lost its registry entry and came back under a new id.
    // The chat is still the bot's chat, and its transcript is keyed by
    // session id — so it moves rather than being abandoned for a fresh one.
    const owner = {
      kind: "bot" as const,
      botId: "bot-1",
      role: "forever" as const,
      key: null,
    };
    const chat = service.create(WORKSPACE, null, owner);
    service.stashAll("acct-1");
    service.restoreFromStash("acct-1", []); // workspace gone: parked as orphan

    expect(service.list("ws-new")).toEqual([]);
    expect(service.ownedOrphans().map((s) => s.id)).toEqual([chat.id]);
    // Found even while orphaned, so a reopen recovers it rather than minting.
    expect(service.findOwned("bot-1", "forever", null)?.id).toBe(chat.id);

    expect(service.rehome(chat.id, "ws-new")).toBe(true);

    expect(service.list("ws-new").map((s) => s.id)).toEqual([chat.id]);
    expect(service.ownedOrphans()).toEqual([]);
    // And it survives the next launch in its new home.
    const fresh = new AgentSessionManagerService();
    fresh.initialize(["ws-new"]);
    expect(fresh.list("ws-new").map((s) => s.id)).toEqual([chat.id]);
  });

  it("parks a restored session whose workspace is gone, without losing it", () => {
    service.create(WORKSPACE);
    service.stashAll("acct-1");

    // Restored while the workspace registry no longer lists WORKSPACE: not in
    // any list, but persisted (same orphan contract as initialize()).
    expect(service.restoreFromStash("acct-1", [])).toBe(1);
    expect(service.list(WORKSPACE)).toEqual([]);
    expect(readStored()).toHaveLength(1);
  });
});
