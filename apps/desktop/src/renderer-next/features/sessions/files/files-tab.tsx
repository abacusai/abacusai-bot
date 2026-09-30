import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { FilePreview, previewKind } from "#next/components/file-preview";
import { FileTreeView } from "#next/components/file-tree";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";
import type { SessionRow } from "#shared/contract/rows";
import type { FileTreeNode } from "#shared/contracts";

import { useSessionsTransport, sessionsQueries } from "../data/queries";
import { isRelativePath } from "../data/search";
export const flattenFiles = (nodes: FileTreeNode[]): string[] =>
  nodes.flatMap((n) => [
    n.relativePath + (n.kind === "directory" ? "/" : ""),
    ...flattenFiles(n.children ?? []),
  ]);
export const SessionFilePreview = ({
  row: _row,
  root,
  path,
  renderLocal,
}: {
  row: SessionRow;
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
  const options = sessionsQueries(transport.orpc);
  const tree = useQuery(options.tree(checkout));
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [children, setChildren] = useState<FileTreeNode[]>([]);
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
      const nodes = await transport.client.files.treeChildren({
        checkout,
        directoryPath: path.slice(0, -1),
      });
      setChildren((s) => [...s, ...nodes]);
      return;
    }
    void navigate({
      to: ".",
      search: (p: Record<string, unknown>) => ({ ...p, file: path }),
      replace: true,
      transition: "none",
    } as never);
  };
  const paths = flattenFiles([...(tree.data?.fileTree ?? []), ...children]);
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
            paths={paths}
            onSelect={(path) => void select(path)}
            onOpen={onPreview}
            onRename={(fromPath, toPath) =>
              void transport.client.files
                .rename({ checkout, fromPath, toPath })
                .then(() => tree.refetch())
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
                onClick={() =>
                  void transport.client.files
                    .trash({ checkout, filePath: selected })
                    .then(() => tree.refetch())
                }
              >
                {t("sessions.files.trash")}
              </Button>
            </div>
            <SessionFilePreview
              row={row}
              root={root}
              path={selected}
              renderLocal={renderLocal}
            />
          </>
        ) : (
          <p className="text-muted-foreground p-4 text-sm">
            {t("sessions.files.select")}
          </p>
        )}
      </section>
    </div>
  );
};
