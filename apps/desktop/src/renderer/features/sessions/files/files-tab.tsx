import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
// The tree adapter treats paths identity as a topology update.
// eslint-disable-next-line no-restricted-imports
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { FilePreview, previewKind } from "#renderer/components/file-preview";
import { FileTreeView } from "#renderer/components/file-tree";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
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
import type { SessionRow } from "#shared/contract/rows";
import type { FileTreeNode } from "#shared/contracts";

import {
  useSessionsTransport,
  useGitState,
  useCheckoutQueries,
  useCheckoutIdentity,
} from "../data/queries";
import { isRelativePath } from "../data/search";
import { useLazyChildren } from "./lazy-children";
export const flattenFiles = (nodes: FileTreeNode[]): string[] =>
  nodes.flatMap((n) => [
    n.relativePath + (n.kind === "directory" ? "/" : ""),
    ...flattenFiles(n.children ?? []),
  ]);
export const SessionFilePreview = ({
  root,
  path,
  renderLocal,
}: {
  root: string;
  path: string;
  renderLocal: (path: string) => ReactNode;
}) => {
  const transport = useSessionsTransport();
  if (!isRelativePath(path)) return null;
  const absolute = `${root}/${path}`;
  const kind = previewKind(absolute);
  if (kind === "pdf" || kind === "html") return <>{renderLocal(absolute)}</>;
  return (
    <FilePreview
      path={absolute}
      hostRoot={root}
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
      onOpenExternally={(path) =>
        void transport.client.system.openPath({ path })
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
  const selected = (useSearch({ strict: false }) as { file?: string }).file;
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const select = async (path: string) => {
    if (path.endsWith("/")) {
      void navigate({
        search: (p: Record<string, unknown>) => ({ ...p, file: path }),
        replace: true,
        transition: "none",
      } as never);
      load(path.slice(0, -1));
      return;
    }
    void navigate({
      to: ".",
      search: (p: Record<string, unknown>) => ({ ...p, file: path }),
      replace: true,
      transition: "none",
    } as never);
  };
  const doTrash = async (path: string) => {
    await transport.client.files.trash({
      checkout,
      filePath: path.replace(/\/$/, ""),
    });
    setTrash(null);
    await tree.refetch();
    void navigate({
      search: (p: Record<string, unknown>) => ({ ...p, file: undefined }),
      replace: true,
      transition: "none",
    } as never);
  };
  const requestTrash = (path: string) => {
    if (path.endsWith("/")) setTrash(path);
    else void doTrash(path).catch((e) => setError(String(e)));
  };
  const paths = useMemo(
    () => flattenFiles([...(tree.data?.fileTree ?? []), ...children]),
    [tree.data?.fileTree, children]
  );
  return (
    <div className="flex size-full min-h-0">
      <aside className="flex w-[232px] min-w-[180px] shrink-0 flex-col gap-2 border-r p-2">
        <Input
          aria-label={t("sessions.files.filter")}
          placeholder={t("sessions.files.filter")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tree.isError ? (
          <Button onClick={() => void tree.refetch()}>
            {t("sessions.common.retry")}
          </Button>
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
                  {
                    label: t("sessions.files.openEditor"),
                    run: () =>
                      void transport.client.system.openPath({
                        path: `${root}/${item.path}`,
                      }),
                  },
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
                  setError(String(e));
                  void tree.refetch();
                })
            }
          />
        )}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
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
              {t("sessions.files.trashFolder")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessions.files.trashFolderBody", { path: trash })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sessions.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                trash && void doTrash(trash).catch((e) => setError(String(e)))
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
