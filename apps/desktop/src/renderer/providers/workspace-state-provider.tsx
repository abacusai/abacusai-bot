import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode } from "react";

import { useWorkspaceWorkspaceMutations } from "../hooks/use-workspace-mutations";
import {
  useWorkspaceActiveWorkspaceId as useWorkspaceActiveWorkspaceIdHook,
  useWorkspaceFileTreeRootQuery,
  useWorkspaceGitStateQuery,
  useWorkspaceMetadataQuery,
} from "../hooks/use-workspace-queries";
import { useWorkspaceRefresh } from "../hooks/use-workspace-refresh";

export const WorkspaceStateProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const queryClient = useQueryClient();
  useWorkspaceRefresh(queryClient);
  return <>{children}</>;
};

export const useWorkspaceMetadata = () => {
  return useWorkspaceMetadataQuery();
};

export const useWorkspaceGitState = ({
  activeWorkspaceId,
  enabled = true,
}: {
  activeWorkspaceId: string | null;
  enabled?: boolean;
}) => {
  return useWorkspaceGitStateQuery({ activeWorkspaceId, enabled });
};

export const useWorkspaceFileTreeRoot = ({
  activeWorkspaceId,
  enabled = true,
}: {
  activeWorkspaceId: string | null;
  enabled?: boolean;
}) => {
  return useWorkspaceFileTreeRootQuery({ activeWorkspaceId, enabled });
};

export const useWorkspaceWorkspaceActions = (
  activeWorkspaceId: string | null
) => {
  const {
    addLocalWorkspace,
    switchWorkspace,
    removeWorkspaceMutation,
    renameWorkspaceMutation,
    relocateWorkspaceMutation,
  } = useWorkspaceWorkspaceMutations(activeWorkspaceId);
  return {
    addLocalWorkspace,
    switchWorkspace,
    removeWorkspaceMutation,
    renameWorkspaceMutation,
    relocateWorkspaceMutation,
  };
};

export const useWorkspaceActiveWorkspaceId = () => {
  return useWorkspaceActiveWorkspaceIdHook();
};
