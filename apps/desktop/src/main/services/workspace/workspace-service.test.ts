/**
 * What a launch lands in.
 *
 * A fresh install seeds nothing: the app used to open in the user's home
 * directory, which pointed the agent at every file they own without them ever
 * choosing it. The renderer holds the app behind its workspace setup page
 * instead, and this is the half that has to stay empty for that to happen.
 */
import fs from "node:fs";
import os from "node:os";
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
const { abacusBotHome, botDefaultWorkspace } = await import("../../paths");

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

describe("the app's own folders across a launch", () => {
  const routineFolder = (): string =>
    path.join(abacusBotHome(), "routines", "job-1");
  const entry = (id: string, where: string, kind?: string) => ({
    id,
    label: id,
    description: where,
    path: where,
    status: "idle",
    isRemote: false,
    ...(kind != null ? { kind } : {}),
  });

  it.each([
    ["a stored routine kind", () => routineFolder(), "routine", "routine"],
    ["a stored bot kind", () => botDefaultWorkspace(), "bot", "bot"],
    [
      "a routine folder an earlier build stripped",
      () => routineFolder(),
      undefined,
      "routine",
    ],
    [
      "bot-home an earlier build stripped",
      () => botDefaultWorkspace(),
      undefined,
      "bot",
    ],
    ["a project", () => "/work/project", undefined, undefined],
  ])("%s", (_name, where, kind, expected) => {
    stored.set("localCode.workspaces", [entry("w", where(), kind)]);

    const service = new WorkspaceService();
    service.initialize();

    expect(service.getWorkspaces()[0]?.kind).toBe(expected);
    // Saved as read: the next launch does not start from less.
    expect(
      (stored.get("localCode.workspaces") as Array<{ kind?: string }>)[0]?.kind
    ).toBe(expected);
  });

  it("does not land on a routine's folder left active by an earlier build", () => {
    stored.set("localCode.workspaces", [
      entry("routine", routineFolder()),
      entry("project", "/work/project"),
    ]);
    stored.set("localCode.activeWorkspaceId", "routine");

    const service = new WorkspaceService();
    service.initialize();

    expect(service.getActiveWorkspaceId()).toBe("project");
  });

  it("does not take the active spot when a routine or bot folder opens", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-kind-"));
    stored.set("localCode.workspaces", [entry("project", "/work/project")]);

    const service = new WorkspaceService();
    service.initialize();
    await service.addWorkspace(folder, false, "routine");
    await service.addWorkspace(folder, false, "bot");

    expect(service.getActiveWorkspaceId()).toBe("project");
    fs.rmSync(folder, { recursive: true, force: true });
  });
});
