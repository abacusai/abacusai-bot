/**
 * What a launch lands in.
 *
 * A fresh install seeds nothing: the app used to open in the user's home
 * directory, which pointed the agent at every file they own without them ever
 * choosing it. The renderer holds the app behind its workspace setup page
 * instead, and this is the half that has to stay empty for that to happen.
 */
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, unknown>();
vi.mock("../session/workspace-store", () => ({
  workspaceStore: {
    get: (key: string) => stored.get(key),
    set: (key: string, value: unknown) => stored.set(key, value),
    delete: (key: string) => stored.delete(key),
  },
}));

const { WorkspaceService } = await import("./workspace-service");

beforeEach(() => {
  stored.clear();
});

describe("workspace service initialize", () => {
  it("seeds no workspace on a fresh install", () => {
    const service = new WorkspaceService();
    service.initialize();

    expect(service.getWorkspaces()).toEqual([]);
    expect(service.getActiveWorkspaceId()).toBeNull();
  });

  it("restores what was stored", () => {
    // Resolved for this platform, because the service resolves what it reads:
    // on Windows `/tmp/repo` comes back as `D:\tmp\repo`, and asserting the
    // POSIX spelling would be asserting the separator rather than the restore.
    const repo = path.resolve("/tmp/repo");

    stored.set("localCode.workspaces", [
      { id: "w1", label: "repo", description: repo, path: repo },
    ]);
    stored.set("localCode.activeWorkspaceId", "w1");

    const service = new WorkspaceService();
    service.initialize();

    expect(service.getActiveWorkspaceId()).toBe("w1");
    expect(service.getActiveWorkspace()?.path).toBe(repo);
  });

  it("does not fall back to home when the only workspace is a tombstone", () => {
    stored.set("localCode.workspaces", [
      {
        id: "w1",
        label: "repo",
        description: "/tmp/repo",
        path: "/tmp/repo",
        status: "deleted",
      },
    ]);

    const service = new WorkspaceService();
    service.initialize();

    expect(service.getActiveWorkspaceId()).toBeNull();
    expect(
      service
        .getWorkspaces()
        .every((workspace) => workspace.status === "deleted")
    ).toBe(true);
  });
});
