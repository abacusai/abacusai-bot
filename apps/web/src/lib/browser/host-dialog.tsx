import type { DirectoryListing } from "@abacus-ai/contract/contract/files";
import { ArrowUp, Folder, FileText } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";

import { FilePreview } from "#renderer/components/file-preview";
import type { AppClient } from "#renderer/data/transport/types";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogFooter,
  DialogDescription,
} from "#renderer/ui/dialog";
import { Input } from "#renderer/ui/input";
import { Skeleton } from "#renderer/ui/skeleton";

export const mountDialog = (render: (close: () => void) => ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const focused = document.activeElement;
  const close = () =>
    queueMicrotask(() => {
      root.unmount();
      container.remove();
      if (focused instanceof HTMLElement && focused.isConnected)
        focused.focus();
    });
  root.render(render(close));
};
export const HostPathPicker = ({
  client,
  mode,
  multiple,
  done,
}: {
  client: AppClient;
  mode: "folder" | "file";
  multiple: boolean;
  done: (paths: string[] | null) => void;
}) => {
  const { t } = useTranslation();
  const [path, setPath] = useState<string>();
  const [listing, setListing] = useState<DirectoryListing>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [newName, setNewName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    client.files
      .listDirectory({ path })
      .then((next) => {
        if (live) {
          setListing(next);
          setLoading(false);
        }
      })
      .catch(() => {
        if (live) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [client, path, attempt]);
  const go = (next: string) => {
    if (
      !listing ||
      (next !== listing.root && !next.startsWith(`${listing.root}/`))
    )
      return;
    setLoading(true);
    setError(false);
    setPath(next);
    setFilter("");
    setSelected([]);
    setNewName(null);
  };
  const up = () => {
    if (listing && listing.path !== listing.root)
      go(listing.path.slice(0, listing.path.lastIndexOf("/")) || "/");
  };
  const entries =
    listing?.entries.filter(
      (entry) =>
        (mode === "file" || entry.kind === "directory") &&
        entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
    ) ?? [];
  const crumbs = listing
    ? [
        listing.root,
        ...listing.path
          .slice(listing.root.length)
          .split("/")
          .filter(Boolean)
          .map(
            (_, index, parts) =>
              `${listing.root}/${parts.slice(0, index + 1).join("/")}`
          ),
      ]
    : [];
  const valid =
    !loading &&
    !error &&
    listing &&
    (mode === "folder" ? listing.path !== listing.root : selected.length > 0);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) done(null);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85dvh] flex-col max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:translate-none max-sm:rounded-none sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              mode === "folder"
                ? "web.files.chooseFolder"
                : "web.files.chooseFiles"
            )}
          </DialogTitle>
          <DialogDescription>{t("web.files.vmHint")}</DialogDescription>
        </DialogHeader>
        <nav
          aria-label={t("web.files.path")}
          className="flex min-w-0 items-center gap-1"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!listing || listing.path === listing.root || loading}
            aria-label={t("web.files.up")}
            onClick={up}
          >
            <ArrowUp />
          </Button>
          <div className="scroll-fade-x flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {crumbs.map((crumb, index) => (
              <Button
                key={crumb}
                variant="ghost"
                size="sm"
                title={crumb}
                className="max-w-40 shrink-0"
                onClick={() => go(crumb)}
                disabled={loading}
              >
                <span className="truncate">
                  {index === 0 ? t("web.files.root") : crumb.split("/").at(-1)}
                </span>
              </Button>
            ))}
          </div>
        </nav>
        <p
          title={listing?.path}
          className="text-muted-foreground truncate font-mono text-xs"
        >
          {listing?.path}
        </p>
        <Input
          aria-label={t("web.files.filter")}
          placeholder={t("web.files.filter")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && filter === "") {
              event.preventDefault();
              up();
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              document
                .querySelector<HTMLButtonElement>("[data-host-path-row]")
                ?.focus();
            }
          }}
        />
        <div
          role="group"
          aria-label={t("web.files.entries")}
          className="scroll-fade-y min-h-40 flex-1 overflow-y-auto"
          onKeyDown={(event) => {
            if (event.key === "Backspace") {
              event.preventDefault();
              up();
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const rows = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[data-host-path-row]"
                ),
              ];
              const index = rows.indexOf(
                document.activeElement as HTMLButtonElement
              );
              rows[
                Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1)
                  )
                )
              ]?.focus();
            }
            if (
              event.key.length === 1 &&
              !event.ctrlKey &&
              !event.metaKey &&
              event.key !== " "
            )
              setFilter((value) => value + event.key);
          }}
        >
          {loading ? (
            <div
              aria-busy="true"
              aria-label={t("web.files.loading")}
              className="space-y-2"
            >
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : error ? (
            <div role="alert" className="space-y-2 p-2">
              <p>{t("web.files.failed")}</p>
              <Button
                onClick={() => {
                  setLoading(true);
                  setError(false);
                  setAttempt(attempt + 1);
                }}
              >
                {t("sessions.common.retry")}
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <p role="status" className="text-muted-foreground p-2">
              {t("web.files.empty")}
            </p>
          ) : (
            entries.map((entry) => (
              <Button
                key={entry.path}
                data-host-path-row
                variant="ghost"
                size="sm"
                title={entry.name}
                aria-pressed={
                  entry.kind === "file"
                    ? selected.includes(entry.path)
                    : undefined
                }
                className="h-8 w-full justify-start"
                onClick={() => {
                  if (entry.kind === "directory") go(entry.path);
                  else
                    setSelected((paths) =>
                      multiple
                        ? paths.includes(entry.path)
                          ? paths.filter((p) => p !== entry.path)
                          : [...paths, entry.path]
                        : [entry.path]
                    );
                }}
              >
                {entry.kind === "directory" ? <Folder /> : <FileText />}
                <span className="truncate">{entry.name}</span>
              </Button>
            ))
          )}
        </div>
        {newName !== null && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!listing || !newName.trim()) return;
              setLoading(true);
              void client.files
                .mkdir({ path: listing.path, name: newName })
                .then(({ path }) => go(path))
                .catch(() => {
                  setError(true);
                  setLoading(false);
                });
            }}
          >
            <Input
              autoFocus
              aria-label={t("web.files.folderName")}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button type="submit" disabled={loading || !newName.trim()}>
              {t("web.files.newFolder")}
            </Button>
          </form>
        )}
        <DialogFooter>
          {mode === "file" && (
            <Button
              variant="outline"
              disabled={
                loading || error || !listing || listing.path === listing.root
              }
              onClick={() => done([listing!.path])}
            >
              {t("web.files.useFolder")}
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={loading || error}
            onClick={() => setNewName(newName === null ? "" : null)}
          >
            {t("web.files.newFolder")}
          </Button>
          <Button variant="secondary" onClick={() => done(null)}>
            {t("phase5.cancel")}
          </Button>
          <Button
            disabled={!valid}
            onClick={() => done(mode === "folder" ? [listing!.path] : selected)}
          >
            {t(
              mode === "folder" ? "web.files.useFolder" : "web.files.useFiles"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
export const pickPaths = (
  client: AppClient,
  mode: "folder" | "file",
  multiple: boolean
) =>
  new Promise<string[] | null>((resolve) =>
    mountDialog((close) => (
      <HostPathPicker
        client={client}
        mode={mode}
        multiple={multiple}
        done={(paths) => {
          resolve(paths);
          close();
        }}
      />
    ))
  );

const HostFileDialog = ({
  client,
  path,
  close,
}: {
  client: AppClient;
  path: string;
  close: () => void;
}) => {
  const { t } = useTranslation();
  const [root, setRoot] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.all([
      client.system.info({}),
      client.db.workspaces.snapshot({}),
    ])
      .then(([info, snapshot]) => {
        if (!live) return;
        const workspace = snapshot.rows.find((row) => row.isActive)?.path;
        const root =
          path.startsWith("/workspace/") || !path.startsWith("/")
            ? workspace
            : path.slice(0, path.lastIndexOf("/")) || info.paths.home;
        if (root) setRoot(root);
        else setError(true);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [client, path, attempt]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[85dvh] flex-col max-sm:inset-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-none max-sm:rounded-none sm:max-w-4xl"
      >
        <DialogTitle className="truncate" title={path}>
          {path.split("/").at(-1)}
        </DialogTitle>
        {error ? (
          <div role="alert">
            <p>{t("bots.chat.preview.failed")}</p>
            <Button
              onClick={() => {
                setError(false);
                setAttempt(attempt + 1);
              }}
            >
              {t("sessions.common.retry")}
            </Button>
          </div>
        ) : !root ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <FilePreview
            path={path}
            hostRoot={root}
            read={{
              text: (filePath, hostRoot) =>
                client.files.readText({
                  filePath,
                  hostRoot,
                  maxBytes: 1000000,
                }),
              image: async (filePath, hostRoot) =>
                (await client.files.readImageAsDataUrl({ filePath, hostRoot }))
                  .dataUrl,
              pptx: (filePath, hostRoot) =>
                client.files.readPptx({ filePath, hostRoot }),
            }}
          />
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
export const viewFile = (client: AppClient, path: string) =>
  mountDialog((close) => (
    <HostFileDialog client={client} path={path} close={close} />
  ));

export const confirmUpload = (
  count: number,
  size: string,
  skipped: number
): Promise<boolean | null> =>
  new Promise((resolve) =>
    mountDialog((close) => (
      <UploadConfirmation
        count={count}
        size={size}
        skipped={skipped}
        done={(include) => {
          resolve(include);
          close();
        }}
      />
    ))
  );
const UploadConfirmation = ({
  count,
  size,
  skipped,
  done,
}: {
  count: number;
  size: string;
  skipped: number;
  done: (include: boolean | null) => void;
}) => {
  const { t } = useTranslation();
  const [include, setInclude] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) done(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("web.files.confirmUpload")}</DialogTitle>
          <DialogDescription>
            {t("web.files.uploadCount", { count, size })}
          </DialogDescription>
        </DialogHeader>
        {skipped > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={include}
              onChange={(event) => setInclude(event.target.checked)}
            />
            {t("web.files.includeJunk", { count: skipped })}
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => done(null)}>
            {t("phase5.cancel")}
          </Button>
          <Button onClick={() => done(include)}>{t("web.files.upload")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
