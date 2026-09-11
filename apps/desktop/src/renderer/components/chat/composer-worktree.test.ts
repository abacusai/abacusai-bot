import { describe, expect, it, vi } from "vitest";

import type {
  AgentSessionListItem,
  WorktreeDraftEnvironment,
} from "#shared/contracts";

import { createPreparedComposerSession } from "./composer-worktree";

const session = { id: "session-1" } as AgentSessionListItem;

describe("createPreparedComposerSession", () => {
  it.each<WorktreeDraftEnvironment>([
    { kind: "current" },
    { kind: "existing", worktreeId: "worktree-1" },
    { kind: "new", baseRef: "HEAD", name: "renderer-cleanup" },
  ])(
    "prepares $kind before returning the created session",
    async (environment) => {
      const order: string[] = [];
      const createSession = vi.fn(async () => {
        order.push("create");
        return session;
      });
      const prepareSession = vi.fn(async () => {
        order.push("prepare");
        return { session, worktree: null };
      });

      await createPreparedComposerSession({
        workspaceId: "workspace-1",
        environment,
        createSession,
        prepareSession,
      });

      expect(order).toEqual(["create", "prepare"]);
      expect(prepareSession).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        environment,
      });
    }
  );

  it("surfaces preparation failure without replacing the staged environment", async () => {
    const environment: WorktreeDraftEnvironment = {
      kind: "new",
      baseRef: "main",
      name: "keep-this-draft",
    };
    const failure = new Error("worktree preparation failed");

    await expect(
      createPreparedComposerSession({
        workspaceId: "workspace-1",
        environment,
        createSession: async () => session,
        prepareSession: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(environment).toEqual({
      kind: "new",
      baseRef: "main",
      name: "keep-this-draft",
    });
  });
});
