import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { workspaceQueryKeys } from "../lib/query-keys";
import { isAppInternalWorkspace } from "../lib/workspace-utils";
import { useWorkspaceStore } from "../stores/code-store";
import { useWorkspaceMetadataQuery } from "./use-workspace-queries";

/**
 * Put the session on the app's own workspace, made on first ask. It is a
 * workspace like any other once active, so the terminal, the file tree and
 * the send path need no case for "nothing picked".
 */
export const activateDefaultWorkspace = async (
  queryClient: QueryClient,
  /** Skip when something was picked while the workspace was being made. */
  { onlyIfNoneActive = false }: { onlyIfNoneActive?: boolean } = {}
): Promise<string | null> => {
  const workspaceId = await window.api.agent.ensureSessionHomeWorkspace();
  if (workspaceId == null) return null;
  if (
    onlyIfNoneActive &&
    useWorkspaceStore.getState().activeWorkspaceId != null
  )
    return null;
  useWorkspaceStore.getState().activateWorkspaceSession(workspaceId, null);
  void window.api.agent.switchWorkspace(workspaceId);
  void queryClient.invalidateQueries({
    queryKey: workspaceQueryKeys.metadata,
  });
  return workspaceId;
};

/**
 * A new session always has a workspace: the last one the user picked while it
 * still exists, else the default. Only where a session is being started: an
 * open session or a routine brings its own.
 */
export const useSessionWorkspace = (enabled: boolean): void => {
  const queryClient = useQueryClient();
  const workspaces = useWorkspaceMetadataQuery().data?.workspaces;
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  const pending = useRef(false);

  useEffect(() => {
    if (!enabled || workspaces == null || activeWorkspaceId != null) return;
    const store = useWorkspaceStore.getState();
    if (store.activeWorkspaceId != null) return;
    const last = workspaces.find(
      (workspace) =>
        workspace.id === store.lastPickedWorkspaceId &&
        workspace.status !== "deleted" &&
        !isAppInternalWorkspace(workspace)
    );
    if (last != null) {
      store.activateWorkspaceSession(last.id, null);
      void window.api.agent.switchWorkspace(last.id);
      return;
    }
    if (pending.current) return;
    pending.current = true;
    void activateDefaultWorkspace(queryClient, {
      onlyIfNoneActive: true,
    }).finally(() => {
      pending.current = false;
    });
  }, [activeWorkspaceId, enabled, queryClient, workspaces]);
};
