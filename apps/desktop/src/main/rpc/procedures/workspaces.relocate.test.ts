/**
 * R4-T33, `workspaces.relocate` on a tombstoned workspace (spec 04 §26.4 d,
 * §17.3 "Choose folder"): the procedure restores it at the new folder; the
 * legacy call keeps today's behaviour (the tombstone stays).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/session/workspace-store", () => ({
  workspaceStore: {
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  },
}));

const { WorkspaceService } =
  await import("../../services/workspace/workspace-service");
const { connectInProcess, fakeDeps } = await import("../testing");

let root = "";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "abacus-relocate-"));
  await fs.mkdir(path.join(root, "old"));
  await fs.mkdir(path.join(root, "new"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const tombstoned = async () => {
  const workspaces = new WorkspaceService();
  workspaces.initialize();
  const added = (await workspaces.addWorkspace(path.join(root, "old"))) as {
    workspaceId: string;
  };
  expect(workspaces.markDeleted(added.workspaceId)).toBe(true);
  return { workspaces, id: added.workspaceId };
};

const statusOf = (
  workspaces: InstanceType<typeof WorkspaceService>,
  id: string
) => workspaces.getWorkspaces().find((entry) => entry.id === id)?.status;

describe("workspaces.relocate (R4-T33)", () => {
  it("the procedure restores a tombstoned workspace at its new folder", async () => {
    const { workspaces, id } = await tombstoned();
    const connection = connectInProcess(
      fakeDeps({
        serviceHost: {
          relocateWorkspace: (
            workspaceId: string,
            newPath: string,
            options?: { restore?: boolean }
          ) => workspaces.relocateWorkspace(workspaceId, newPath, options),
        },
      })
    );

    await connection.client.workspaces.relocate({
      workspaceId: id,
      newPath: path.join(root, "new"),
    });

    const workspace = workspaces
      .getWorkspaces()
      .find((entry) => entry.id === id)!;
    expect(workspace.status).not.toBe("deleted");
    expect(workspace.path).toBe(path.join(root, "new"));
    connection.closeClient();
    connection.closeServer();
  });

  it("the legacy call relocates but keeps the tombstone", async () => {
    const { workspaces, id } = await tombstoned();
    await expect(
      workspaces.relocateWorkspace(id, path.join(root, "new"))
    ).resolves.toEqual({ success: true });
    expect(statusOf(workspaces, id)).toBe("deleted");
  });

  it("restore leaves a live workspace's status alone", async () => {
    const workspaces = new WorkspaceService();
    workspaces.initialize();
    const added = (await workspaces.addWorkspace(path.join(root, "old"))) as {
      workspaceId: string;
    };
    await workspaces.relocateWorkspace(
      added.workspaceId,
      path.join(root, "new"),
      {
        restore: true,
      }
    );
    expect(statusOf(workspaces, added.workspaceId)).toBe("active");
  });
});
