import type { ArtifactRow } from "@abacus-ai/contract/contract/rows";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useLiveQuery } from "@tanstack/react-db";
import { useSearch } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Ellipsis } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#renderer/components/empty-state";
import { FilePreview } from "#renderer/components/file-preview";
import { Segments } from "#renderer/components/form-kit/controls";
import { PageToolbar } from "#renderer/components/form-kit/page";
import { NavList } from "#renderer/components/nav-list";
import { useCollections } from "#renderer/data/db";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showInfo, showError } from "#renderer/lib/toast";
import { useAppContext, useSystem } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "#renderer/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import { Input } from "#renderer/ui/input";
import { NativeSelect, NativeSelectOption } from "#renderer/ui/native-select";

import {
  sourceFor,
  filterArtifacts,
  dirname,
  formatForArtifact,
  openArtifact,
  artifactTarget,
  artifactListEntries,
  type ArtifactListEntry,
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
// Keep the virtualizer's mutable instance outside React Compiler's cached render.
const useArtifactWindow = (
  entries: ArtifactListEntry[],
  columns: number,
  list: boolean,
  viewport: RefObject<HTMLDivElement | null>,
  selected?: string
) => {
  "use no memo";
  const virtualizer = useVirtualizer({
    count: Math.ceil(entries.length / columns),
    getScrollElement: () => viewport.current,
    estimateSize: () => (list ? 72 : 190),
    overscan: 4,
    initialRect: { width: 800, height: 800 },
    getItemKey: (index) => {
      const entry = entries[index * columns]!;
      return "artifact" in entry ? entry.artifact.id : entry.day;
    },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const firstRow = virtualRows[0];
  const lastRow = virtualRows.at(-1);
  const selectedIndex = selected
    ? entries.findIndex(
        (entry) => "artifact" in entry && entry.artifact.id === selected
      )
    : -1;
  useEffect(() => {
    if (selectedIndex >= 0)
      virtualizer.scrollToIndex(Math.floor(selectedIndex / columns), {
        align: "auto",
      });
  }, [selectedIndex, columns, virtualizer]);
  return {
    start: (firstRow?.index ?? 0) * columns,
    end: ((lastRow?.index ?? -1) + 1) * columns,
    before: firstRow?.start ?? 0,
    after: virtualizer.getTotalSize() - (lastRow?.end ?? 0),
  };
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
      <NavList.Header title={t("artifacts.sidebar.label")} />
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
      {refs.length > 0 && (
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
      )}
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
  // The grid lives in the wide content column (tokens.css), so columns
  // come from the column's width, not the viewport's.
  const column = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 800 });
  const [notice, setNotice] = useState<Record<string, string>>({});
  const list = search.view === "list" || !!search.item;
  // Phone widths fit two narrower cards instead of one stretched card.
  const columns = list
    ? 1
    : Math.max(1, Math.floor(size.width / (size.width < 440 ? 160 : 210)));
  const entries = artifactListEntries(filtered, list && search.sort !== "name");
  const window = useArtifactWindow(
    entries,
    columns,
    list,
    viewport,
    search.item
  );
  const hasViewport = filtered.length > 0;
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect)
        setSize({
          width: column.current?.clientWidth || rect.width,
          height: rect.height,
        });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasViewport]);
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
      ...(!IS_ELECTRON || a.kind === "link"
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
                // Built from the artifact's data at runtime.
                void navigate(target as never),
            },
          ]
        : []),
    ];
  };
  const actions = (a: ArtifactRow) => (
    <div className="flex flex-wrap gap-2 border-b px-3 pb-3">
      {actionItems(a).map((item) => (
        <Button
          key={item.label}
          size="sm"
          variant="secondary"
          onClick={item.run}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
  return (
    <div className="flex size-full flex-col">
      <header className="content-col-wide shrink-0 py-4">
        <PageToolbar>
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            <h1 className="page-title">{t("shell.rail.artifacts")}</h1>
            <span className="text-muted-foreground text-xs whitespace-nowrap">
              {t("phase5.items", { count: filtered.length })}
            </span>
          </div>
          <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
            <Segments
              label={t("phase5.artifactView")}
              value={list ? "list" : "grid"}
              values={[
                { value: "grid", label: t("phase5.grid") },
                { value: "list", label: t("phase5.list") },
              ]}
              onChange={(view) => set({ view: view as "grid" | "list" })}
            />
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
          </div>
        </PageToolbar>
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
                : "min-w-0 flex-1 overflow-auto py-5"
            }
          >
            <div
              ref={column}
              className={search.item ? undefined : "content-col-wide"}
            >
              <div style={{ height: window.before }} />
              <div
                role="list"
                className={list ? "flex flex-col gap-0" : "grid gap-2.5"}
                style={
                  list
                    ? undefined
                    : {
                        gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`,
                      }
                }
              >
                {entries.slice(window.start, window.end).map((entry) => {
                  if ("day" in entry)
                    return (
                      <div
                        key={entry.day}
                        role="listitem"
                        className="text-muted-foreground flex h-[72px] items-center px-3 text-xs font-medium"
                      >
                        {new Date(entry.date).toLocaleDateString(
                          i18n.language,
                          {
                            dateStyle: "full",
                          }
                        )}
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
                                  ? "flex h-[72px] min-w-0 items-center gap-3 px-3 pr-9 text-left"
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
                                if (e.key === "Escape")
                                  set({ item: undefined });
                              }}
                            >
                              {!list && <ArtifactThumbnail artifact={a} />}
                              <div className="min-w-0 flex-1 px-3 py-2">
                                <p className="truncate text-[13px] font-medium">
                                  {a.title}
                                </p>
                                <p className="text-muted-foreground truncate text-xs">
                                  {t(`phase5.formats.${formatForArtifact(a)}`)}{" "}
                                  · {sources.get(a.id)?.label}
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
                            {notice[a.id] && (
                              <p role="status">{notice[a.id]}</p>
                            )}
                          </div>
                        }
                      />
                      <ContextMenuContent>
                        <ContextMenuGroup>
                          {actionItems(a).map((item) => (
                            <ContextMenuItem
                              key={item.label}
                              onClick={item.run}
                            >
                              {item.label}
                            </ContextMenuItem>
                          ))}
                        </ContextMenuGroup>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
              <div
                style={{
                  height: window.after,
                }}
              />
            </div>
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
                      onOpenExternally={
                        IS_ELECTRON ? () => void open(selected) : undefined
                      }
                      showActions={false}
                      path={selected.location}
                      hostRoot={dirname(selected.location)}
                      read={{
                        localUrl: IS_ELECTRON
                          ? async (filePath, hostRoot) => {
                              const state =
                                await transport.client.browser.runtime.materializeFile(
                                  {
                                    filePath,
                                    hostRoot,
                                    conversationKey: sessionConversationKey(
                                      selected.workspaceId,
                                      selected.sessionId
                                    ),
                                    resourceId: `artifact-preview:${selected.id}`,
                                  }
                                );
                              await transport.client.browser.runtime.close(
                                state.lease
                              );
                              return state.url;
                            }
                          : undefined,
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

export { artifactGalleryRows } from "./gallery";

/** Native driver seeds gallery files inside its isolated application home. */
export const ArtifactsStressGallery = () => {
  const system = useSystem();
  return (
    <ArtifactsPage
      fixtureRows={artifactStressRows.map((row) => ({
        ...row,
        location: `${system.paths.botHome}${row.location}`,
      }))}
    />
  );
};
