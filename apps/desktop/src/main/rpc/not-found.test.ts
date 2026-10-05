/**
 * A stale id is NOT_FOUND { entity, id } (spec 00 A.5; Codex impl-r1 #8), so
 * the renderer can drop a stale selection, and not a CONFLICT or an internal
 * error. The failures come from the real workspace service; the legacy IPC
 * shapes they travel in are unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/session/workspace-store", () => ({
  workspaceStore: {
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  },
}));

const { WorkspaceService } =
  await import("../services/workspace/workspace-service");
const { EntityNotFoundError, WORKSPACE_NOT_FOUND } =
  await import("@abacus-ai/contract/not-found");
const { connectInProcess, fakeDeps } = await import("./testing");

const connections: Array<{ closeClient(): void; closeServer(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const connect = (serviceHost: object) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const connection = connectInProcess(fakeDeps({ serviceHost }));
  connections.push(connection);
  return connection.client;
};

describe("NOT_FOUND for an entity that is gone", () => {
  it("workspaces.switch to an unknown workspace", async () => {
    const workspaces = new WorkspaceService();
    workspaces.initialize();
    // The legacy handler's result, as it has always been.
    expect(workspaces.switchWorkspace("w-gone")).toEqual({
      success: false,
      error: WORKSPACE_NOT_FOUND,
    });
    const client = connect({
      switchWorkspace: async (id: string) => workspaces.switchWorkspace(id),
    });

    await expect(
      client.workspaces.switch({ workspaceId: "w-gone" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      defined: true,
      data: { entity: "workspace", id: "w-gone" },
    });
  });

  it("workspaces.relocate of an unknown workspace", async () => {
    const workspaces = new WorkspaceService();
    workspaces.initialize();
    const client = connect({
      relocateWorkspace: (id: string, newPath: string) =>
        workspaces.relocateWorkspace(id, newPath),
    });

    await expect(
      client.workspaces.relocate({ workspaceId: "w-gone", newPath: "/tmp" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { entity: "workspace", id: "w-gone" },
    });
  });

  it("keeps other workspace failures a CONFLICT", async () => {
    const client = connect({
      relocateWorkspace: async () => ({
        success: false,
        error: "Another workspace already uses that folder.",
      }),
    });

    await expect(
      client.workspaces.relocate({ workspaceId: "w1", newPath: "/tmp" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("routines.editByChat for a deleted routine", async () => {
    const client = connect({
      editRoutineByChat: async (routineId: string) => {
        throw new EntityNotFoundError(
          "routine",
          routineId,
          "This routine is gone."
        );
      },
    });

    await expect(
      client.routines.editByChat({ routineId: "r-gone", text: "hi" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { entity: "routine", id: "r-gone" },
    });
  });

  it("leaves the legacy rejection text as it was", () => {
    // Electron's invoke rejection carries String(error).
    expect(
      String(new EntityNotFoundError("routine", "r", "This routine is gone."))
    ).toBe("Error: This routine is gone.");
  });
});
