import { useCallback } from "react";

import {
  useWorkspaceActiveWorkspaceId,
  useWorkspaceMetadata,
} from "../providers/workspace-state-provider";

/** Null before metadata loads. */
export const useWorkspaceRoot = (): string | null => {
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const metadata = useWorkspaceMetadata();
  return (
    metadata.data?.workspaces?.find((w) => w.id === activeWorkspaceId)?.path ??
    null
  );
};

// A relative tool-reported path fails the file read and silently falls
// through to the OS opener, so anchor it to the workspace first.
export const useResolveWorkspacePath = (): ((path: string) => string) => {
  const workspaceRoot = useWorkspaceRoot();
  return useCallback(
    (path: string) => {
      if (path.length === 0) return path;
      const isAbsolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
      if (isAbsolute || workspaceRoot == null) return path;
      return `${workspaceRoot.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
    },
    [workspaceRoot]
  );
};
