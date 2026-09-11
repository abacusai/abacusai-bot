import { describe, expect, it, vi } from "vitest";

import { IpcChannels } from "#shared/channels";

import { createBridge } from "./bridge";

describe("worktree preload bridge", () => {
  it("forwards workspace and session scope without falling back to the active workspace", async () => {
    const invoke = vi.fn(async () => undefined);
    const bridge = createBridge({ invoke } as never);

    await bridge.listWorktrees({ workspaceId: "workspace-1" });
    await bridge.createWorktree({
      workspaceId: "workspace-1",
      baseRef: "main",
      name: "review",
    });
    await bridge.setSessionWorktree({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      worktreeId: "worktree-1",
    });
    await bridge.materializeSessionWorktree({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      baseRef: "main",
      name: "review",
    });
    const context = { workspaceId: "workspace-1", sessionId: "session-1" };
    await bridge.getGitBranches(context);
    await bridge.getGitCurrentBranch(context);
    await bridge.getPrInfo(context);
    await bridge.switchGitBranch("feature", context);
    await bridge.createGitBranch("new-feature", context);

    expect(invoke.mock.calls).toEqual([
      [IpcChannels.ListWorktrees, { workspaceId: "workspace-1" }],
      [
        IpcChannels.CreateWorktree,
        { workspaceId: "workspace-1", baseRef: "main", name: "review" },
      ],
      [
        IpcChannels.SetSessionWorktree,
        {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          worktreeId: "worktree-1",
        },
      ],
      [
        IpcChannels.MaterializeSessionWorktree,
        {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          baseRef: "main",
          name: "review",
        },
      ],
      [IpcChannels.GetGitBranches, context],
      [IpcChannels.GetGitCurrentBranch, context],
      [IpcChannels.GetPrInfo, context],
      [IpcChannels.SwitchGitBranch, "feature", context],
      [IpcChannels.CreateGitBranch, "new-feature", context],
    ]);
  });
});
