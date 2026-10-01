import { useLiveQuery } from "@tanstack/react-db";
import { useSearch } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { FilePreview } from "#next/components/file-preview";
import { Segments } from "#next/components/form-kit/controls";
import { NavList } from "#next/components/nav-list";
import { useCollections } from "#next/data/db";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { showInfo, showError } from "#next/lib/toast";
import { useAppContext } from "#next/lib/use-app-context";
import { Button } from "#next/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "#next/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#next/ui/dropdown-menu";
import { Input } from "#next/ui/input";
import { NativeSelect, NativeSelectOption } from "#next/ui/native-select";
import type { ArtifactRow } from "#shared/contract/rows";

import {
  sourceFor,
  filterArtifacts,
  dirname,
  formatForArtifact,
  openArtifact,
  artifactTarget,
  cardWindow,
  artifactListEntries,
} from "./data";
import { artifactStressRows } from "./gallery";
import { ArtifactThumbnail } from "./thumbnail";
const useArtifacts = (fixtureRows?: readonly ArtifactRow[]) => {
  const c = useCollections();
  const liveRows = useLiveQuery(c.artifacts).data ?? [];
  const rows = fixtureRows ?? liveRows;
  const sessions = useLiveQuery(c.sessions).data ?? [];
  const bots = useLiveQuery(c.bots).data ?? [];
  const routines = useLiveQuery(c.routines).data ?? [];
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  return {
    rows,
    bots,
    workspaces,
    sources: new Map(
      rows.map((a) => [
        a.id,
        sourceFor(a, sessions, routines, bots, workspaces),
      ])
    ),
  };
};
type Search = {
  q?: string;
  type?: "file" | "image" | "link";
  from?: string;
  item?: string;
  view?: "grid" | "list";
  sort?: "newest" | "oldest" | "name";
};
export const ArtifactsSidebar = () => {
  const { t } = useTranslation();
  const { rows, bots, workspaces, sources } = useArtifacts();
  const search = useSearch({ strict: false }) as Search;
  const navigate = useAppNavigate();
  const found = filterArtifacts(rows, sources, { ...search, type: undefined });
  const set = (patch: Partial<Search>) =>
    void navigate({
      search: (p) => ({ ...p, ...patch }),
      replace: true,
      transition: "none",
    });
  const refs = [
    ...bots
      .filter((b) => rows.some((a) => sources.get(a.id)?.botIds.includes(b.id)))
      .map((b) => ({ id: `bot:${b.id}`, label: b.name })),
    ...workspaces
      .filter(
        (w) =>
          (w.kind == null || w.kind === "auto") &&
          rows.some((a) => a.workspaceId === w.id)
      )
      .map((w) => ({ id: `workspace:${w.id}`, label: w.label ?? w.path })),
    ...(rows.some((a) => sources.get(a.id)?.routine)
      ? [{ id: "routines", label: t("shell.rail.routines") }]
      : []),
  ];
  return (
    <NavList.Root label={t("artifacts.sidebar.label")}>
      <Input
        aria-label={t("phase5.searchArtifacts")}
        placeholder={t("phase5.searchArtifacts")}
        value={search.q ?? ""}
        onChange={(e) => set({ q: e.target.value || undefined })}
        onKeyDown={(e) => {
          if (e.key === "Escape") set({ q: undefined });
        }}
      />
      <NavList.Group label={t("artifacts.sidebar.type")}>
        {([undefined, "file", "image", "link"] as const).map((type) => (
          <NavList.Item
            key={type ?? "all"}
            to="/artifacts"
            search={{ ...search, type }}
            transition="none"
            title={`${t(type ? `phase5.artifactTypes.${type}` : "artifacts.sidebar.all")} (${found.filter((a) => !type || a.kind === type).length})`}
            active={search.type === type}
          />
        ))}
      </NavList.Group>
      <NavList.Group label={t("artifacts.sidebar.source")}>
        {refs.map((ref) => (
          <NavList.Item
            key={ref.id}
            to="/artifacts"
            search={{
              ...search,
              from: search.from === ref.id ? undefined : ref.id,
            }}
            transition="none"
            title={ref.label}
            active={search.from === ref.id}
          />
        ))}
      </NavList.Group>
    </NavList.Root>
  );
};
export const ArtifactsPage = ({
  fixtureRows,
}: { fixtureRows?: readonly ArtifactRow[] } = {}) => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const { rows, sources } = useArtifacts(fixtureRows);
  const search = useSearch({ strict: false }) as Search;
  const navigate = useAppNavigate();
  const filtered = filterArtifacts(rows, sources, search);
  const selected = rows.find((a) => a.id === search.item);
  const viewport = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [size, setSize] = useState({ width: 800, height: 800 });
  const [notice, setNotice] = useState<Record<string, string>>({});
  const list = search.view === "list" || !!search.item;
  const columns = list ? 1 : Math.max(1, Math.floor(size.width / 210));
  const entries = artifactListEntries(filtered, list && search.sort !== "name");
  const window = cardWindow(
    entries.length,
    top,
    columns,
    list ? 48 : 190,
    size.height
  );
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [filtered.length > 0]);
  useEffect(() => {
    if (!search.item) return;
    const index = entries.findIndex(
      (entry) => "artifact" in entry && entry.artifact.id === search.item
    );
    if (index < 0) return;
    const offset = Math.floor(index / columns) * (list ? 48 : 190);
    if (
      viewport.current &&
      (offset < top || offset > top + viewport.current.clientHeight)
    ) {
      viewport.current.scrollTop = offset;
      setTop(offset);
    }
  }, [search.item, entries, columns, list, top]);
  const set = (patch: Partial<Search>) =>
    void navigate({ search: (p) => ({ ...p, ...patch }), transition: "none" });
  const open = async (a: (typeof rows)[number]) => {
    try {
      const result = await openArtifact(transport, a);
      if (result === "missing")
        setNotice((n) => ({ ...n, [a.id]: t("phase5.fileMissing") }));
      else if (result !== "opened") showInfo(t(`phase5.open.${result}`));
    } catch {
      showError(t("phase5.failed"));
    }
  };
  const actionItems = (a: ArtifactRow) => {
    const target = artifactTarget(sources.get(a.id)!, a.sessionId);
    return [
      {
        label: t(a.kind === "link" ? "phase5.openBrowser" : "phase5.openFile"),
        run: () => void open(a),
      },
      ...(a.kind === "link"
        ? []
        : [
            {
              label: t("phase5.reveal"),
              run: () =>
                void transport.client.system
                  .showItemInFolder({ path: a.location })
                  .catch(() => showError(t("phase5.failed"))),
            },
          ]),
      {
        label: t("phase5.copy"),
        run: () =>
          void navigator.clipboard
            .writeText(a.location)
            .then(() => showInfo(t("phase5.copied")))
            .catch(() => showError(t("phase5.failed"))),
      },
      ...(target
        ? [
            {
              label: t("phase5.goSession"),
              run: () =>
                void navigate(target as Parameters<typeof navigate>[0]),
            },
          ]
        : []),
    ];
  };
  const actions = (a: ArtifactRow) => (
    <div className="flex flex-wrap gap-1">
      {actionItems(a).map((item) => (
        <Button key={item.label} size="sm" variant="ghost" onClick={item.run}>
          {item.label}
        </Button>
      ))}
    </div>
  );
  return (
    <div className="flex size-full flex-col">
      <header className="flex h-14 items-center gap-3 px-5">
        <h1 className="text-base font-semibold">{t("shell.rail.artifacts")}</h1>
        <span className="text-muted-foreground text-xs">
          {t("phase5.items", { count: filtered.length })}
        </span>
        <div className="ml-auto">
          <Segments
            label={t("phase5.artifactView")}
            value={search.view ?? "grid"}
            values={[
              { value: "grid", label: t("phase5.grid") },
              { value: "list", label: t("phase5.list") },
            ]}
            onChange={(view) => set({ view: view as "grid" | "list" })}
          />
        </div>
        <NativeSelect
          aria-label={t("phase5.sort")}
          value={search.sort ?? "newest"}
          onChange={(e) =>
            set({ sort: e.target.value as "newest" | "oldest" | "name" })
          }
        >
          {["newest", "oldest", "name"].map((x) => (
            <NativeSelectOption key={x} value={x}>
              {t(`phase5.sorts.${x}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </header>
      <div className="flex min-h-0 flex-1">
        {filtered.length === 0 ? (
          <EmptyState
            icon="artifacts"
            title={t(
              rows.length
                ? "phase5.nothingMatches"
                : "artifacts.page.emptyTitle"
            )}
            description={t("artifacts.page.emptyDescription")}
            action={
              rows.length ? (
                <Button
                  onClick={() =>
                    set({ q: undefined, type: undefined, from: undefined })
                  }
                >
                  {t("phase5.clearSearch")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div
            ref={viewport}
            className={
              search.item
                ? "hidden w-[420px] shrink-0 overflow-auto p-3 lg:block"
                : "min-w-0 flex-1 overflow-auto p-5"
            }
            onScroll={(e) => setTop(e.currentTarget.scrollTop)}
          >
            <div style={{ height: window.before }} />
            <div
              role="list"
              className={list ? "flex flex-col gap-0" : "grid gap-2.5"}
              style={
                list
                  ? undefined
                  : { gridTemplateColumns: `repeat(${columns},minmax(0,1fr))` }
              }
            >
              {entries.slice(window.start, window.end).map((entry) => {
                if ("day" in entry)
                  return (
                    <div
                      key={entry.day}
                      role="listitem"
                      className="text-muted-foreground flex h-12 items-center px-3 text-xs font-medium"
                    >
                      {new Date(entry.date).toLocaleDateString(i18n.language, {
                        dateStyle: "full",
                      })}
                    </div>
                  );
                const a = entry.artifact;
                return (
                  <ContextMenu key={a.id}>
                    <ContextMenuTrigger
                      render={
                        <div
                          key={a.id}
                          role="listitem"
                          data-artifact-card
                          className="bg-card relative flex flex-col overflow-hidden rounded-xl"
                        >
                          <button
                            className={
                              list
                                ? "flex h-12 items-center gap-3 px-3 text-left"
                                : "flex h-[180px] flex-col text-left"
                            }
                            aria-current={
                              search.item === a.id ? "true" : undefined
                            }
                            onClick={() => set({ item: a.id })}
                            onDoubleClick={() => void open(a)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void open(a);
                              }
                              if (e.key === "Escape") set({ item: undefined });
                            }}
                          >
                            {!list && <ArtifactThumbnail artifact={a} />}
                            <div className="min-w-0 px-3 py-2">
                              <p className="truncate text-[13px] font-medium">
                                {a.title}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">
                                {t(`phase5.formats.${formatForArtifact(a)}`)} ·{" "}
                                {sources.get(a.id)?.label}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                {new Date(a.updatedAt).toLocaleDateString(
                                  i18n.language
                                )}
                              </p>
                            </div>
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="absolute top-1 right-1"
                                  aria-label={
                                    t("phase5.manage") + " " + a.title
                                  }
                                >
                                  <Ellipsis />
                                </Button>
                              }
                            />
                            <DropdownMenuContent>
                              <DropdownMenuGroup>
                                {actionItems(a).map((item) => (
                                  <DropdownMenuItem
                                    key={item.label}
                                    onClick={item.run}
                                  >
                                    {item.label}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          {notice[a.id] && <p role="status">{notice[a.id]}</p>}
                        </div>
                      }
                    />
                    <ContextMenuContent>
                      <ContextMenuGroup>
                        {actionItems(a).map((item) => (
                          <ContextMenuItem key={item.label} onClick={item.run}>
                            {item.label}
                          </ContextMenuItem>
                        ))}
                      </ContextMenuGroup>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
            <div style={{ height: window.after }} />
          </div>
        )}
        {search.item && (
          <section
            aria-label={t("phase5.artifactPreview")}
            className="bg-card m-2 flex min-w-0 flex-1 flex-col rounded-xl"
          >
            <header className="flex items-center justify-between p-3">
              <h2 className="truncate font-medium">
                {selected?.title ?? t("phase5.artifactGone")}
              </h2>
              <Button
                aria-label={t("phase5.closePreview")}
                size="sm"
                variant="ghost"
                onClick={() => set({ item: undefined })}
              >
                {t("phase5.close")}
              </Button>
            </header>
            {selected && (
              <>
                {actions(selected)}
                {notice[selected.id] && (
                  <p role="status">{notice[selected.id]}</p>
                )}
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {selected.kind === "link" ? (
                    <code>{selected.location}</code>
                  ) : (
                    <FilePreview
                      path={selected.location}
                      hostRoot={dirname(selected.location)}
                      read={{
                        text: (filePath, hostRoot) =>
                          transport.client.files.readText({
                            filePath,
                            hostRoot,
                            maxBytes: 1048576,
                          }),
                        image: async (filePath, hostRoot) =>
                          (
                            await transport.client.files.readImageAsDataUrl({
                              filePath,
                              hostRoot,
                            })
                          ).dataUrl,
                        pptx: (filePath, hostRoot) =>
                          transport.client.files.readPptx({
                            filePath,
                            hostRoot,
                          }),
                      }}
                      onOpenExternally={() => void open(selected)}
                      onReveal={() =>
                        void transport.client.system.showItemInFolder({
                          path: selected.location,
                        })
                      }
                    />
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
};

export { artifactGalleryRows, artifactStressRows } from "./gallery";

/** Native driver seeds gallery files inside its isolated application home. */
export const ArtifactsStressGallery = () => {
  const { system } = useAppContext();
  return (
    <ArtifactsPage
      fixtureRows={artifactStressRows.map((row) => ({
        ...row,
        location: `${system.paths.botHome}${row.location}`,
      }))}
    />
  );
};
