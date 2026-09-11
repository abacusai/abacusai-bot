import { describe, expect, it } from "vitest";

import type { AgentSessionListItem } from "#shared/contracts";

import { resolveSessionWorkspacePath } from "./session-workspace-context";

const sessions = new Map<string, AgentSessionListItem>([
  [
    "chat-a",
    {
      id: "chat-a",
      workspaceId: "workspace-1",
      worktreePath: "/managed/chat-a",
    } as AgentSessionListItem,
  ],
  [
    "chat-b",
    {
      id: "chat-b",
      workspaceId: "workspace-1",
      worktreePath: "/managed/chat-b",
    } as AgentSessionListItem,
  ],
  [
    "main-chat",
    {
      id: "main-chat",
      workspaceId: "workspace-1",
      worktreePath: null,
    } as AgentSessionListItem,
  ],
]);

const resolve = (sessionId?: string) =>
  resolveSessionWorkspacePath(
    { workspaceId: "workspace-1", ...(sessionId ? { sessionId } : {}) },
    "/projects/repository",
    (id) => sessions.get(id) ?? null
  );

describe("conversation workspace context", () => {
  it("keeps two chats in one workspace bound to their own checkouts", () => {
    expect(resolve("chat-a")).toBe("/managed/chat-a");
    expect(resolve("chat-b")).toBe("/managed/chat-b");
  });

  it("uses the workspace root only when the valid session has no worktree", () => {
    expect(resolve("main-chat")).toBe("/projects/repository");
    expect(resolve()).toBe("/projects/repository");
    expect(resolve("missing")).toBeNull();
  });
});
