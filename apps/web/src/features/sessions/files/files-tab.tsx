import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import type { FileTreeNode } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
// The tree adapter treats paths identity as a topology update.
// eslint-disable-next-line no-restricted-imports
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  containmentRootFor,
  FilePreview,
  previewKind,
} from "#renderer/components/file-preview";
import { FileTreeView } from "#renderer/components/file-tree";
import { failureText } from "#renderer/lib/error-text";
import { i18n } from "#renderer/lib/i18n";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
import { Skeleton } from "#renderer/ui/skeleton";

import {
  useSessionsTransport,
  useGitState,
  useCheckoutQueries,
  useCheckoutIdentity,
} from "../data/queries";
import { isRelativePath } from "../data/search";
import { panelTabsStore, updateTab } from "../dock/panel-tabs-store";
import { useLazyChildren } from "./lazy-children";
import { isAbsolutePreviewPath } from "./preview-target";
export const flattenFiles = (nodes: FileTreeNode[]): string[] =>
  nodes.flatMap((n) => [
    n.relativePath + (n.kind === "directory" ? "/" : ""),
    ...flattenFiles(n.children ?? []),
  ]);
export const SessionFilePreview = ({
  root,
  path,
  renderLocal,
  preview = false,
  inTab = preview,
  visible = true,
  onShown,
}: {
  preview?: boolean;
  visible?: boolean;
  /** The in-page viewer (not a native view) is on screen: it counts as drawn. */
  onShown?: () => void;
  /** Rendered in a dock tab that already shows the file name. */
  inTab?: boolean;
  root: string;
  path: string;
  renderLocal: (path: string) => ReactNode;
}) => {
  const transport = useSessionsTransport();
  const outside = isAbsolutePreviewPath(path);
  const native =
    IS_ELECTRON &&
    ["pdf", "html"].includes(previewKind(outside ? path : `${root}/${path}`));
  const shown = useEffectEvent(() => onShown?.());
  const viewer = !native && (outside || isRelativePath(path));
  useEffect(() => {
    if (viewer && visible) shown();
  }, [viewer, visible, path]);
  if (!outside && !isRelativePath(path))
    return (
      <p role="alert" className="p-4">
        {i18n.t("bots.chat.preview.failed")}
      </p>
    );
  // A file outside the checkout is read under its own directory.
  const absolute = outside ? path : `${root}/${path}`;
  const hostRoot = outside ? containmentRootFor(path, root) : root;
  const kind = previewKind(absolute);
  if (IS_ELECTRON && (kind === "pdf" || kind === "html"))
    return <>{renderLocal(absolute)}</>;
  return (
    <FilePreview
      hideTitle={inTab}
      initialView={preview ? "preview" : "source"}
      path={absolute}
      hostRoot={hostRoot}
      read={{
        text: (filePath, hostRoot) =>
          transport.client.files.readText({
            filePath,
            hostRoot,
            maxBytes: 1000000,
          }),
        image: async (filePath, hostRoot) =>
          (
            await transport.client.files.readImageAsDataUrl({
              filePath,
              hostRoot,
            })
          ).dataUrl,
        pptx: (filePath, hostRoot) =>
          transport.client.files.readPptx({ filePath, hostRoot }),
      }}
      onOpenExternally={
        IS_ELECTRON
          ? (path) => void transport.client.system.openPath({ path })
          : undefined
      }
      onReveal={
        IS_ELECTRON
          ? (path) => void transport.client.system.showItemInFolder({ path })
          : undefined
      }
    />
  );
};
export const FilesTab = ({
  row,
  root,
  onPreview,
  renderLocal,
}: {
  row: SessionRow;
  root: string;
  onPreview: (path: string) => void;
  renderLocal: (path: string) => ReactNode;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const checkout = { workspaceId: row.workspaceId, sessionId: row.id };
  const options = useCheckoutQueries(checkout);
  const tree = useQuery(options.tree(checkout));
  const git = useGitState(checkout);
  const [trash, setTrash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const checkoutIdentity = useCheckoutIdentity(checkout);
  const { children, load } = useLazyChildren(
    checkoutIdentity,
    tree.dataUpdatedAt,
    (directory) => options.children(checkout, directory)
  );
  const search = useQuery({
    ...options.search(checkout, debounced),
    enabled: debounced !== "",
  });
  const key = sessionConversationKey(row.workspaceId, row.id);
  const file = (useSearch({ strict: false }) as { file?: string }).file;
  const saved = useSelector(
    panelTabsStore,
    (s) => s[key]?.tabs.find((tab) => tab.ref === "files")?.path
  );
  const selected = file ?? saved;
  useEffect(() => {
    if (file != null) updateTab(key, "files", { path: file });
  }, [key, file]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const select = async (path: string) => {
    updateTab(key, "files", { path });
    if (path.endsWith("/")) {
      void navigate({
        search: (p: Record<string, unknown>) => ({ ...p, file: path }),
        replace: true,
        transition: "none",
      });
      load(path.slice(0, -1));
      return;
    }
    void navigate({
      to: ".",
      search: (p: Record<string, unknown>) => ({ ...p, file: path }),
      replace: true,
      transition: "none",
    });
  };
  const doTrash = async (path: string) => {
    await transport.client.files.trash({
      checkout,
      filePath: path.replace(/\/$/, ""),
    });
    setTrash(null);
    updateTab(key, "files", { path: undefined });
    await tree.refetch();
    void navigate({
      search: (p: Record<string, unknown>) => ({ ...p, file: undefined }),
      replace: true,
      transition: "none",
    });
  };
  const requestTrash = (path: string) => {
    if (!IS_ELECTRON || path.endsWith("/")) setTrash(path);
    else void doTrash(path).catch((e) => setError(failureText(e)));
  };
  const paths = useMemo(
    () => flattenFiles([...(tree.data?.fileTree ?? []), ...children]),
    [tree.data?.fileTree, children]
  );
  return (
    <div className="flex size-full min-h-0">
      <aside
        className={
          IS_ELECTRON
            ? "flex w-[232px] min-w-[180px] shrink-0 flex-col gap-2 border-r p-2"
            : "flex w-2/5 max-w-[232px] min-w-[120px] shrink-0 flex-col gap-2 border-r p-2"
        }
      >
        <Input
          aria-label={t("sessions.files.filter")}
          placeholder={t("sessions.files.filter")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!IS_ELECTRON && (
          <Button variant="ghost" size="sm" onClick={() => void tree.refetch()}>
            {t("web.files.refresh")}
          </Button>
        )}
        {tree.isError ? (
          <div role="alert">
            <p>{t("web.files.failed")}</p>
            <Button onClick={() => void tree.refetch()}>
              {t("sessions.common.retry")}
            </Button>
          </div>
        ) : !debounced && tree.isPending ? (
          <div role="status">
            <Skeleton className="h-8 w-full" />
            <span className="sr-only">{t("web.files.loading")}</span>
          </div>
        ) : !debounced && paths.length === 0 ? (
          <p role="status">{t("web.files.empty")}</p>
        ) : debounced && search.isPending ? (
          <Skeleton className="h-8 w-full" />
        ) : debounced && search.isError ? (
          <div role="alert">
            <p>{t("web.files.failed")}</p>
            <Button onClick={() => void search.refetch()}>
              {t("sessions.common.retry")}
            </Button>
          </div>
        ) : debounced && search.data?.items.length === 0 ? (
          <p role="status">{t("web.files.empty")}</p>
        ) : debounced ? (
          search.data?.items.map((item) => (
            <Button
              key={item.relativePath}
              variant="ghost"
              onClick={() => void select(item.relativePath)}
              onDoubleClick={() => onPreview(item.relativePath)}
            >
              {item.fileName}
            </Button>
          ))
        ) : (
          <FileTreeView
            checkoutIdentity={`${row.id}:${checkoutIdentity}`}
            paths={paths}
            gitStatus={git?.gitChanges.map((c) => ({
              path: c.path,
              status:
                c.status === "?" || c.status === "??"
                  ? "untracked"
                  : c.status.includes("D")
                    ? "deleted"
                    : c.status.includes("A")
                      ? "added"
                      : "modified",
            }))}
            renderMenu={(item, context, rename) => (
              <div
                role="menu"
                className="bg-popover flex flex-col rounded-lg border p-1 shadow-md"
              >
                {[
                  {
                    label: t("sessions.files.preview"),
                    run: () => onPreview(item.path),
                  },
                  ...(IS_ELECTRON
                    ? [
                        {
                          label: t("sessions.files.openEditor"),
                          run: () =>
                            void platformSystem(transport.client).openPath({
                              path: `${root}/${item.path}`,
                            }),
                        },
                      ]
                    : []),
                  { label: t("sessions.files.rename"), run: rename },
                  {
                    label: t("sessions.files.copyPath"),
                    run: () => void navigator.clipboard.writeText(item.path),
                  },
                  {
                    label: t("sessions.files.trash"),
                    run: () =>
                      requestTrash(
                        item.path +
                          (item.kind === "directory" && !item.path.endsWith("/")
                            ? "/"
                            : "")
                      ),
                  },
                ].map((action) => (
                  <Button
                    key={action.label}
                    role="menuitem"
                    size="sm"
                    variant="ghost"
                    className="justify-start"
                    onClick={() => {
                      context.close();
                      action.run();
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
            onSelect={(path) => void select(path)}
            onOpen={onPreview}
            onRename={(fromPath, toPath) =>
              void transport.client.files
                .rename({ checkout, fromPath, toPath })
                .then(() => tree.refetch())
                .catch((e) => {
                  setError(failureText(e));
                  void tree.refetch();
                })
            }
          />
        )}
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2">
              <span className="w-full truncate font-mono text-xs">
                {selected}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onPreview(selected)}
              >
                {t("sessions.files.preview")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => requestTrash(selected)}
              >
                {t("sessions.files.trash")}
              </Button>
            </div>
            {!selected.endsWith("/") ? (
              <SessionFilePreview
                root={root}
                path={selected}
                renderLocal={renderLocal}
              />
            ) : (
              <p className="text-muted-foreground p-4 text-sm">{selected}</p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground p-4 text-sm">
            {t("sessions.files.select")}
          </p>
        )}
      </section>
      {error ? <p role="alert">{error}</p> : null}
      <AlertDialog
        open={trash !== null}
        onOpenChange={(open) => {
          if (!open) setTrash(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                IS_ELECTRON
                  ? "sessions.files.trashFolder"
                  : "web.files.trashTitle"
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                IS_ELECTRON
                  ? "sessions.files.trashFolderBody"
                  : "web.files.trashBody",
                { path: trash }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sessions.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                trash &&
                void doTrash(trash).catch((e) => setError(failureText(e)))
              }
            >
              {t("sessions.files.trash")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
