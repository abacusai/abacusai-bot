import { prepareFileTreeInput } from "@pierre/trees";
import type {
  GitStatusEntry,
  GitStatus,
  ContextMenuItem,
  ContextMenuOpenContext,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useQueryClient } from "@tanstack/react-query";
import { FileSearch, FolderSearch, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { FileTreeNode } from "#shared/contracts";

import {
  workspaceQueryKeys,
  LOCAL_CODE_QUERY_STALE_TIMES,
} from "../../lib/query-keys";
import {
  useWorkspaceActiveWorkspaceId,
  useWorkspaceGitState,
  useWorkspaceFileTreeRoot,
  useWorkspaceMetadata,
} from "../../providers/workspace-state-provider";
import { openFileInPreview } from "../../utils/preview-utils";
import { secondarySidebarPanelPaddingClassName } from "../layout/workspace-view";
import { Button, Empty, EmptyDescription } from "../ui";

const mapGitStatusCode = (status: string): GitStatus => {
  if (status.includes("?")) return "untracked";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  if (status.includes("R")) return "renamed";
  return "modified";
};

const buildGitStatusEntries = (
  gitChanges: Array<{ path: string; status: string }>
): GitStatusEntry[] =>
  gitChanges
    .filter(
      (change) =>
        typeof change?.path === "string" && typeof change?.status === "string"
    )
    .map((change) => ({
      path: change.path.replace(/\\/g, "/"),
      status: mapGitStatusCode(change.status),
    }));

// Pierre requires a trailing slash to recognise a path as a directory.
const toTreePath = (node: FileTreeNode): string =>
  node.kind === "directory" ? `${node.relativePath}/` : node.relativePath;

type DirLoadState = "pending" | "loading" | "loaded";

// Inherits app theme colors, VS Code-matching git status colors, compact density.
const TREE_STYLE = {
  display: "block",
  height: "100%",
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-bg-muted-override":
    "color-mix(in srgb, var(--foreground) 6%, transparent)",
  "--trees-border-color-override": "var(--border)",
  "--trees-selected-bg-override": "var(--primary)",
  "--trees-selected-fg-override": "var(--primary-foreground)",
  "--trees-accent-override": "var(--primary)",
  "--trees-git-modified-color-override": "#e2c08d",
  "--trees-git-added-color-override": "#73c991",
  "--trees-git-untracked-color-override": "#73c991",
  "--trees-git-deleted-color-override": "#f14c4c",
  "--trees-git-renamed-color-override": "#73c991",
  "--trees-status-modified-override": "#e2c08d",
  "--trees-status-added-override": "#73c991",
  "--trees-status-untracked-override": "#73c991",
  "--trees-status-deleted-override": "#f14c4c",
  "--trees-status-renamed-override": "#73c991",
} as React.CSSProperties;

export const ExplorerPanel = (): JSX.Element => {
  const queryClient = useQueryClient();
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();

  const metadataQuery = useWorkspaceMetadata();
  const fileTreeRootQuery = useWorkspaceFileTreeRoot({
    activeWorkspaceId,
    enabled: activeWorkspaceId != null,
  });
  const gitStateQuery = useWorkspaceGitState({
    activeWorkspaceId,
    enabled: activeWorkspaceId != null,
  });

  // Resolve the absolute root path for the active workspace
  const activeWorkspacePath = useMemo(() => {
    if (activeWorkspaceId == null) return null;
    return (
      metadataQuery.data?.workspaces.find((w) => w.id === activeWorkspaceId)
        ?.path ?? null
    );
  }, [metadataQuery.data, activeWorkspaceId]);

  // Constructor-captured closures read these refs for the latest values.
  const activeWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const activeWorkspacePathRef = useRef<string | null>(activeWorkspacePath);
  activeWorkspacePathRef.current = activeWorkspacePath;

  // Track which directory paths are in the tree and their load state
  const dirLoadState = useRef(new Map<string, DirLoadState>());
  const prevWorkspaceId = useRef<string | null>(null);
  // Populated by canDrag, read in onDragStart.
  const draggedPathsRef = useRef<string[]>([]);

  const { t } = useTranslation();

  const { model } = useFileTree({
    paths: [],
    icons: { set: "complete", colored: true },
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    density: "compact",
    renaming: {
      onRename: ({ sourcePath, destinationPath }) => {
        const wsId = activeWorkspaceIdRef.current;
        void window.api.agent
          .renameLocalFile(sourcePath, destinationPath)
          .then(() => {
            model.move(sourcePath, destinationPath);
            if (wsId != null) {
              void queryClient.invalidateQueries({
                queryKey: workspaceQueryKeys.fileTreeRoot(wsId),
              });
              void queryClient.invalidateQueries({
                queryKey: workspaceQueryKeys.fileTreeChildren(wsId),
              });
              void queryClient.invalidateQueries({
                queryKey: workspaceQueryKeys.gitState(wsId),
              });
            }
          })
          .catch(() => {
            // Revert by re-reading the current paths from query cache
            const rootNodes: FileTreeNode[] =
              (queryClient.getQueryData(
                workspaceQueryKeys.fileTreeRoot(wsId ?? "__idle__")
              ) as FileTreeNode[]) ?? [];
            if (rootNodes.length > 0) {
              const rootPaths = rootNodes.map(toTreePath);
              const prepared = prepareFileTreeInput(rootPaths, {
                flattenEmptyDirectories: true,
              });
              model.resetPaths(prepared.paths);
            }
          });
      },
    },
    dragAndDrop: {
      canDrag: (paths) => {
        draggedPathsRef.current = [...paths];
        return true;
      },
      onDropComplete: ({ draggedPaths, target }) => {
        const wsId = activeWorkspaceIdRef.current;
        for (const fromPath of draggedPaths) {
          const dirPath = target.directoryPath ?? "";
          const basename = fromPath.split("/").pop() ?? fromPath;
          const toPath = dirPath ? `${dirPath}/${basename}` : basename;
          void window.api.agent
            .renameLocalFile(fromPath, toPath)
            .then(() => {
              model.move(fromPath, toPath);
              if (wsId != null) {
                void queryClient.invalidateQueries({
                  queryKey: workspaceQueryKeys.fileTreeRoot(wsId),
                });
                void queryClient.invalidateQueries({
                  queryKey: workspaceQueryKeys.fileTreeChildren(wsId),
                });
                void queryClient.invalidateQueries({
                  queryKey: workspaceQueryKeys.gitState(wsId),
                });
              }
            })
            .catch(() => {
              /* ignore; the watcher will re-sync */
            });
        }
      },
    },
  });

  // Reset tree when workspace changes
  useEffect(() => {
    if (activeWorkspaceId !== prevWorkspaceId.current) {
      prevWorkspaceId.current = activeWorkspaceId;
      model.resetPaths([]);
      dirLoadState.current.clear();
    }
  }, [model, activeWorkspaceId]);

  // prepareFileTreeInput keeps large trees cheap to populate.
  useEffect(() => {
    const rootNodes: FileTreeNode[] = fileTreeRootQuery.data?.fileTree ?? [];
    if (rootNodes.length === 0) return;

    const rootPaths = rootNodes.map(toTreePath);
    const prepared = prepareFileTreeInput(rootPaths, {
      flattenEmptyDirectories: true,
    });
    model.resetPaths(prepared.paths);
    dirLoadState.current.clear();
    for (const node of rootNodes) {
      if (node.kind === "directory") {
        dirLoadState.current.set(node.relativePath, "pending");
      }
    }
  }, [model, fileTreeRootQuery.data]);

  // Sync git status into the model
  useEffect(() => {
    const entries = buildGitStatusEntries(gitStateQuery.data?.gitChanges ?? []);
    model.setGitStatus(entries);
  }, [model, gitStateQuery.data]);

  // Lazy-load directory children on expansion
  useEffect(() => {
    if (activeWorkspaceId == null) return;

    return model.subscribe(() => {
      for (const [dirPath, state] of dirLoadState.current) {
        if (state !== "pending") continue;
        const item = model.getItem(dirPath);
        if (item == null || !item.isDirectory()) continue;
        if (
          !(
            item as import("@pierre/trees").FileTreeDirectoryHandle
          ).isExpanded()
        )
          continue;

        dirLoadState.current.set(dirPath, "loading");

        void queryClient
          .fetchQuery({
            queryKey: workspaceQueryKeys.fileTreeDirectoryChildren(
              activeWorkspaceId,
              dirPath
            ),
            queryFn: () => window.api.agent.getFileTreeChildren(dirPath),
            staleTime: LOCAL_CODE_QUERY_STALE_TIMES.fileTreeDirectoryChildren,
          })
          .then((nodes) => {
            for (const node of nodes) {
              model.add(toTreePath(node));
              if (
                node.kind === "directory" &&
                !dirLoadState.current.has(node.relativePath)
              ) {
                dirLoadState.current.set(node.relativePath, "pending");
              }
            }
            dirLoadState.current.set(dirPath, "loaded");
          })
          .catch(() => {
            dirLoadState.current.set(dirPath, "pending"); // allow retry on next expand
          });
      }
    });
  }, [model, queryClient, activeWorkspaceId]);

  const openFilePreview = useCallback((relativePath: string) => {
    if (relativePath.endsWith("/")) return;
    const workspacePath = activeWorkspacePathRef.current;
    void openFileInPreview(relativePath, workspacePath);
  }, []);

  // dataTransfer carries the paths so the composer can accept the drop.
  const handleExternalDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (draggedPathsRef.current.length === 0) return;
      const workspacePath = activeWorkspacePathRef.current;
      const absPaths = draggedPathsRef.current.map((p) => {
        const clean = p.replace(/\/$/, "");
        return workspacePath != null ? `${workspacePath}/${clean}` : clean;
      });
      e.dataTransfer.setData("text/x-code-paths", JSON.stringify(absPaths));
    },
    []
  );

  // Double-click on a file row opens preview
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      for (const target of e.nativeEvent.composedPath()) {
        const el = target as Element;
        if (el.getAttribute == null) continue;
        if (el.getAttribute("data-item-type") !== "file") continue;
        const rawPath = el.getAttribute("data-item-path");
        if (rawPath == null) break;
        openFilePreview(rawPath);
        break;
      }
    },
    [openFilePreview]
  );

  // Hover prefetch
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const wsId = activeWorkspaceIdRef.current;
      if (wsId == null) return;
      for (const target of event.nativeEvent.composedPath()) {
        if (!(target instanceof Element)) continue;
        if (target.getAttribute("data-item-type") !== "folder") continue;
        const rawPath = target.getAttribute("data-item-path");
        if (rawPath == null) break;
        const dirPath = rawPath.replace(/\/$/, "");
        if (!dirLoadState.current.has(dirPath)) break;
        void queryClient.prefetchQuery({
          queryKey: workspaceQueryKeys.fileTreeDirectoryChildren(wsId, dirPath),
          queryFn: () => window.api.agent.getFileTreeChildren(dirPath),
          staleTime: LOCAL_CODE_QUERY_STALE_TIMES.fileTreeDirectoryChildren,
        });
        break;
      }
    },
    [queryClient]
  );

  // Context menu renderer for rename / trash / reveal
  const renderContextMenu = useCallback(
    (item: ContextMenuItem, context: ContextMenuOpenContext) => {
      const absPath = activeWorkspacePathRef.current
        ? `${activeWorkspacePathRef.current}/${item.path.replace(/\/$/, "")}`
        : null;
      return (
        <div
          role="menu"
          className="bg-popover text-popover-foreground z-50 min-w-36 overflow-hidden rounded-md border p-1 shadow-md"
          data-file-tree-context-menu-root="true"
        >
          {!item.path.endsWith("/") ? (
            <Button
              variant="ghost"
              size="sm"
              role="menuitem"
              className="h-7 w-full justify-start px-2"
              onClick={() => {
                context.close();
                openFilePreview(item.path);
              }}
            >
              <FileSearch />
              Open Preview
            </Button>
          ) : null}
          {absPath != null && (
            <Button
              variant="ghost"
              size="sm"
              role="menuitem"
              className="h-7 w-full justify-start px-2"
              onClick={() => {
                context.close();
                void window.api.showItemInFolder(absPath);
              }}
            >
              <FolderSearch />
              Reveal in Finder
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            role="menuitem"
            className="h-7 w-full justify-start px-2"
            onClick={() => {
              context.close();
              model.startRenaming(item.path, { removeIfCanceled: false });
            }}
          >
            <Pencil />
            Rename
          </Button>
          <Button
            variant="ghost"
            size="sm"
            role="menuitem"
            className="text-destructive hover:text-destructive h-7 w-full justify-start px-2"
            onClick={() => {
              context.close();
              const wsId = activeWorkspaceIdRef.current;
              void window.api.agent.trashLocalFile(item.path).then(() => {
                model.remove(item.path, { recursive: true });
                if (wsId != null) {
                  void queryClient.invalidateQueries({
                    queryKey: workspaceQueryKeys.fileTreeRoot(wsId),
                  });
                  void queryClient.invalidateQueries({
                    queryKey: workspaceQueryKeys.fileTreeChildren(wsId),
                  });
                  void queryClient.invalidateQueries({
                    queryKey: workspaceQueryKeys.gitState(wsId),
                  });
                }
              });
            }}
          >
            <Trash2 />
            Move to Trash
          </Button>
        </div>
      );
    },
    [model, queryClient, openFilePreview]
  );

  if (activeWorkspaceId == null) {
    return (
      <div className={secondarySidebarPanelPaddingClassName}>
        <Empty className="flex-none items-start px-2 py-6 text-start">
          <EmptyDescription>
            {t("workspace.explorer.noWorkspace")}
          </EmptyDescription>
        </Empty>
      </div>
    );
  }

  if (fileTreeRootQuery.isPending) {
    return (
      <div className={secondarySidebarPanelPaddingClassName}>
        <Empty className="flex-none items-start px-2 py-6 text-start">
          <EmptyDescription>Loading files...</EmptyDescription>
        </Empty>
      </div>
    );
  }

  if (fileTreeRootQuery.isError) {
    return (
      <div className={secondarySidebarPanelPaddingClassName}>
        <Empty className="flex-none items-start px-2 py-6 text-start">
          <EmptyDescription>
            {t("workspace.explorer.loadFailed")}
          </EmptyDescription>
        </Empty>
      </div>
    );
  }

  if ((fileTreeRootQuery.data?.fileTree.length ?? 0) === 0) {
    return (
      <div className={secondarySidebarPanelPaddingClassName}>
        <Empty className="flex-none items-start px-2 py-6 text-start">
          <EmptyDescription>{t("workspace.explorer.noFiles")}</EmptyDescription>
        </Empty>
      </div>
    );
  }

  return (
    <div
      className="h-full"
      onPointerMove={handlePointerMove}
      onDoubleClick={handleDoubleClick}
      onDragStart={handleExternalDragStart}
    >
      <FileTree
        model={model}
        style={TREE_STYLE}
        renderContextMenu={renderContextMenu}
      />
    </div>
  );
};
