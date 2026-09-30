/**
 * R4-T33, `git.worktrees.materialize` idempotency (spec 04 §26.4 g): a
 * repeat of one `(sessionId, operationId)`, sequential or concurrent,
 * creates one branch and one path and returns the recorded result; the
 * session row carries `worktreeOperationId`; a detach clears it; a call
 * without an operation id (the legacy renderer) still creates one each time.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/session/workspace-store", () => ({
  workspaceStore: {
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  },
}));

const { AgentSessionManagerService } =
  await import("../../services/session/agent-session-manager-service");
const { GitService } = await import("../../services/workspace/git-service");
const { WorktreeMaterializer } =
  await import("../../services/workspace/worktree-materialize");
const { readSessionRows } = await import("../tables/sessions");
const { connectInProcess, fakeDeps } = await import("../testing");

const execFileAsync = promisify(execFile);
const WS = "11111111-1111-4111-8111-111111111111";
const OPERATION = "op-7c1f";

let root = "";
let repo = "";
let managed = "";

const git = (...args: string[]) => execFileAsync("git", ["-C", repo, ...args]);

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "abacus-materialize-"))
  );
  repo = path.join(root, "repo");
  managed = path.join(root, "managed");
  await fs.mkdir(repo);
  await git("init", "-b", "main");
  await git("config", "user.email", "materialize@example.invalid");
  await git("config", "user.name", "Materialize Test");
  await fs.writeFile(path.join(repo, "README.md"), "ready\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await git("worktree", "prune").catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

/** ServiceHost's wiring, on the real services. */
const setup = () => {
  const sessions = new AgentSessionManagerService();
  sessions.initialize([WS]);
  const gitService = new GitService();
  const create = vi.fn((request: { baseRef: string; name?: string }) =>
    gitService.createWorktree(repo, managed, request.baseRef, request.name)
  );
  const materializer = new WorktreeMaterializer({
    session: (id) => sessions.get(id),
    recorded: (id) => sessions.worktreeOperation(id),
    create,
    attach: async ({ workspaceId, sessionId, worktreeId, operationId }) => {
      const listed = await gitService.listWorktrees(repo, managed);
      const worktree = listed.worktrees.find(
        (entry) => entry.id === worktreeId
      );
      if (worktree == null) return { success: false, error: "gone" };
      sessions.updateWorktree(
        workspaceId,
        sessionId,
        { id: worktree.id, path: worktree.path, branch: worktree.branch },
        operationId == null ? undefined : { operationId, worktree }
      );
      return { success: true, session: sessions.get(sessionId)! };
    },
    remove: async (_workspaceId, worktreePath) =>
      gitService.removeManagedWorktree(repo, managed, worktreePath),
  });
  const session = sessions.create(WS);
  const rows = () =>
    readSessionRows({
      listAllAgentSessions: () => sessions.listAll(),
      listSessionTurnStates: () => [],
    } as never);
  return { sessions, materializer, create, session, rows };
};

const branches = async () =>
  (await git("branch", "--format=%(refname:short)")).stdout
    .split("\n")
    .filter((name) => name.startsWith("abacus/"));
const managedPaths = async () =>
  (await fs.readdir(managed).catch(() => [])).sort();

describe("git.worktrees.materialize (R4-T33)", () => {
  it("a repeated operation id creates one branch and path and returns the recorded result", async () => {
    const { materializer, create, session, rows } = setup();
    const request = {
      workspaceId: WS,
      sessionId: session.id,
      baseRef: "main",
      name: "feature",
      operationId: OPERATION,
    };

    const first = await materializer.materialize(request);
    // A reload after the server's success: the same id again.
    const second = await materializer.materialize(request);

    expect(first.success).toBe(true);
    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await branches()).toHaveLength(1);
    expect(await managedPaths()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      worktreeId: first.worktree!.id,
      worktreeOperationId: OPERATION,
    });
  });

  it("concurrent repeats join the call in flight", async () => {
    const { materializer, create, session } = setup();
    const request = {
      workspaceId: WS,
      sessionId: session.id,
      baseRef: "main",
      operationId: OPERATION,
    };
    const [a, b] = await Promise.all([
      materializer.materialize(request),
      materializer.materialize(request),
    ]);
    expect(a).toEqual(b);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await managedPaths()).toHaveLength(1);
  });

  it("a detach clears the record; a new operation id creates another; no id creates each time", async () => {
    const { sessions, materializer, create, session, rows } = setup();
    await materializer.materialize({
      workspaceId: WS,
      sessionId: session.id,
      baseRef: "main",
      operationId: OPERATION,
    });
    sessions.updateWorktree(WS, session.id, null);
    expect(rows()[0]).toMatchObject({
      worktreeId: null,
      worktreeOperationId: null,
    });

    await materializer.materialize({
      workspaceId: WS,
      sessionId: session.id,
      baseRef: "main",
      operationId: "op-second",
    });
    await materializer.materialize({
      workspaceId: WS,
      sessionId: session.id,
      baseRef: "main",
    });
    await materializer.materialize({
      workspaceId: WS,
      sessionId: session.id,
      baseRef: "main",
    });
    expect(create).toHaveBeenCalledTimes(4);
    expect(await managedPaths()).toHaveLength(4);
    // The legacy calls recorded nothing.
    expect(rows()[0]!.worktreeOperationId).toBeNull();
  });

  it("the procedure requires an operation id and passes it to main", async () => {
    const materialize = vi.fn(async () => ({ success: true }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const connection = connectInProcess(
      fakeDeps({ serviceHost: { materializeSessionWorktree: materialize } })
    );
    const base = {
      workspaceId: WS,
      sessionId: "22222222-2222-4222-8222-222222222222",
      baseRef: "main",
    };
    await expect(
      connection.client.git.worktrees.materialize(base as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await connection.client.git.worktrees.materialize({
      ...base,
      operationId: OPERATION,
    });
    expect(materialize).toHaveBeenCalledWith({
      ...base,
      operationId: OPERATION,
    });
    connection.closeClient();
    connection.closeServer();
  });
});
