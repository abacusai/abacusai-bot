import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionListItem, WorktreeListItem } from "#shared/contracts";

import { workspaceQueryKeys } from "../lib/query-keys";
import {
  type PreparedSessionWorktree,
  usePrepareSessionWorktreeMutation,
  useSetSessionWorktreeMutation,
  useWorktreesQuery,
} from "./use-worktrees";

const mainWorktree: WorktreeListItem = {
  id: "main-checkout",
  name: "project",
  path: "/tmp/project",
  branch: "main",
  isCurrent: true,
  isManaged: false,
};

const managedWorktree: WorktreeListItem = {
  id: "managed-checkout",
  name: "review-1234",
  path: "/tmp/managed/review-1234",
  branch: "abacus/review-1234",
  isCurrent: false,
  isManaged: true,
};

const session = {
  id: "session-1",
  workspaceId: "workspace-1",
  worktreeId: managedWorktree.id,
  worktreePath: managedWorktree.path,
  worktreeBranch: managedWorktree.branch,
} as AgentSessionListItem;

const listWorktrees = vi.fn();
const setSessionWorktree = vi.fn();
const materializeSessionWorktree = vi.fn();

const createClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

const wrapperFor = (client: QueryClient) =>
  function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };

beforeEach(() => {
  listWorktrees.mockResolvedValue({
    success: true,
    worktrees: [mainWorktree, managedWorktree],
  });
  setSessionWorktree.mockResolvedValue({ success: true, session });
  materializeSessionWorktree.mockResolvedValue({
    success: true,
    session,
    worktree: managedWorktree,
  });
  (window as unknown as { api: unknown }).api = {
    agent: {
      listWorktrees,
      setSessionWorktree,
      materializeSessionWorktree,
    },
  };
});

describe("worktree queries", () => {
  it("scopes lists by explicit workspace id and surfaces backend errors", async () => {
    const client = createClient();
    const { result } = renderHook(() => useWorktreesQuery("workspace-1"), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([mainWorktree, managedWorktree]);
    expect(listWorktrees).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });

    listWorktrees.mockResolvedValueOnce({
      success: false,
      worktrees: [],
      error: "No repository",
    });
    const refetched = await result.current.refetch();
    expect(refetched?.error).toEqual(new Error("No repository"));
  });
});

describe("worktree mutations", () => {
  it("switches a stopped session and invalidates the scoped session caches", async () => {
    const client = createClient();
    client.setQueryData(workspaceQueryKeys.worktrees("workspace-1"), [
      mainWorktree,
    ]);
    client.setQueryData(workspaceQueryKeys.agentSessions("workspace-1"), []);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSetSessionWorktreeMutation(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => {
      await result.current.mutateAsync({
        workspaceId: "workspace-1",
        sessionId: session.id,
        worktreeId: managedWorktree.id,
      });
    });

    expect(setSessionWorktree).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: session.id,
      worktreeId: managedWorktree.id,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: workspaceQueryKeys.worktrees("workspace-1"),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: workspaceQueryKeys.agentSessions("workspace-1"),
    });
  });

  it("materializes the new-chat environment through one pending/error mutation", async () => {
    const client = createClient();
    const { result } = renderHook(() => usePrepareSessionWorktreeMutation(), {
      wrapper: wrapperFor(client),
    });

    let prepared: PreparedSessionWorktree | undefined;
    await act(async () => {
      prepared = await result.current.mutateAsync({
        workspaceId: "workspace-1",
        sessionId: session.id,
        environment: {
          kind: "new",
          baseRef: "main",
          name: "Review",
        },
      });
    });

    expect(materializeSessionWorktree).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: session.id,
      baseRef: "main",
      name: "Review",
    });
    expect(prepared).toEqual({ session, worktree: managedWorktree });
    expect(result.current.isError).toBe(false);
  });
});
