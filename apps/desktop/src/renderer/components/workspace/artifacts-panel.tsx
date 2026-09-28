import {
  Search,
  X,
  RotateCw,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  Copy,
  Check,
  FolderOpen,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { SessionArtifact, SessionArtifactKind } from "#shared/contracts";
import { sessionConversationKey } from "#shared/conversation-scope";

import { prefetchTranscript } from "../../conversation/persistence";
import {
  useAllAgentSessionsQuery,
  useSessionArtifactsQuery,
} from "../../hooks/use-workspace-queries";
import { setActiveConversationKey } from "../../stores/active-conversation-store";
import {
  openAbsoluteFileInPreview,
  openUrlInPreview,
  type PreviewTarget,
} from "../../utils/preview-utils";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageToolbar,
} from "../layout/focused-page";
import { fuzzyMatch, sessionAge } from "../layout/session-list-utils";
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  ToggleGroup,
  ToggleGroupItem,
} from "../ui";
import { useConversationActivator } from "./workspace-activation";

/**
 * Title, session, and a lane the width of the two buttons. The path used to
 * take the middle of the row and four lines of it; what is left is what a
 * person scans for.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-3 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_auto]";

type ArtifactFilterId = "all" | "images" | "files" | "links";

const FILTER_KINDS: Record<ArtifactFilterId, SessionArtifactKind | null> = {
  all: null,
  images: "image",
  files: "file",
  links: "link",
};

/** Same "now / 17m / 16h / 54d" wording the sidebar's session rows use. */
const ArtifactAgeLabel = ({
  timestamp,
  now,
}: {
  timestamp: string;
  now: number;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const age = sessionAge(timestamp, now);
  if (age == null) return null;

  const label =
    age.unit === "now"
      ? t("workspace.ageNow")
      : age.unit === "minutes"
        ? t("workspace.ageMinutes", { count: age.count })
        : age.unit === "hours"
          ? t("workspace.ageHours", { count: age.count })
          : t("workspace.ageDays", { count: age.count });

  return (
    <span className="text-muted-foreground block text-xs tabular-nums">
      {label}
    </span>
  );
};

const kindIcon = (kind: SessionArtifactKind): JSX.Element => {
  if (kind === "image")
    return <ImageIcon className="text-muted-foreground size-4" />;
  if (kind === "link")
    return <LinkIcon className="text-muted-foreground size-4" />;
  return <FileText className="text-muted-foreground size-4" />;
};

/**
 * The end of the location: a file's name, a link's host. The whole path says
 * where the app keeps its profiles, which is the same for every row and tells
 * the user nothing about which artifact this is.
 */
const locationTail = (artifact: SessionArtifact): string => {
  const location = artifact.location;
  if (artifact.kind === "link") {
    try {
      return new URL(location).host;
    } catch {
      return location;
    }
  }

  return location.split(/[/\\]/).filter(Boolean).at(-1) ?? location;
};

/**
 * What the location column is for: getting to the file, not reading its path.
 * The path itself was four wrapped lines of monospace that nobody reads and
 * that pushed the two things people actually press to the edge of the row,
 * so it moved into their tooltips, where a full path belongs.
 */
const ArtifactActions = ({
  artifact,
}: {
  artifact: SessionArtifact;
}): JSX.Element => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isLink = artifact.kind === "link";

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    void navigator.clipboard.writeText(artifact.location).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };

  return (
    <span
      className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
      data-id={`artifact-location-${artifact.id}`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        aria-label={isLink ? t("artifacts.copyUrl") : t("artifacts.copyPath")}
        // The path is here, where it is read on purpose rather than at a
        // glance: which of two same-named files this is, in full.
        title={copied ? t("artifacts.copied") : artifact.location}
        data-id={`artifact-copy-${artifact.id}`}
      >
        {copied ? <Check className="text-green-500" /> : <Copy />}
      </Button>
      {!isLink && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void window.api.showItemInFolder(artifact.location)}
          aria-label={t("artifacts.revealInFolder")}
          title={t("artifacts.revealInFolder")}
          data-id={`artifact-reveal-${artifact.id}`}
        >
          <FolderOpen />
        </Button>
      )}
    </span>
  );
};

/**
 * Every file a session wrote and every page it opened, across all workspaces,
 * newest first. Search matches the artifact's name and location and its
 * session's title, since the thing you remember is usually one or the other.
 */
export const ArtifactsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const artifactsQuery = useSessionArtifactsQuery();
  const sessionsQuery = useAllAgentSessionsQuery();
  const activateSelection = useConversationActivator();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ArtifactFilterId>("all");
  const [now] = useState(() => Date.now());
  // Per-row feedback for a click that could not open the preview pane; one at
  // a time, on the row just clicked.
  const [notice, setNotice] = useState<{ id: string; message: string } | null>(
    null
  );

  const artifacts = useMemo(
    () => artifactsQuery.data ?? [],
    [artifactsQuery.data]
  );
  const sessionLabels = useMemo(() => {
    const labels = new Map<string, { label: string; updatedAt: string }>();
    for (const session of sessionsQuery.data ?? []) {
      labels.set(session.id, {
        label: session.label ?? "",
        updatedAt: session.updatedAt ?? session.createdAt,
      });
    }
    return labels;
  }, [sessionsQuery.data]);

  const trimmedQuery = query.trim();

  const searched = useMemo(() => {
    if (trimmedQuery.length === 0) return artifacts;
    return artifacts.filter((artifact) => {
      const sessionLabel = sessionLabels.get(artifact.sessionId)?.label ?? "";
      return (
        fuzzyMatch(trimmedQuery, artifact.title) != null ||
        fuzzyMatch(trimmedQuery, artifact.location) != null ||
        fuzzyMatch(trimmedQuery, sessionLabel) != null
      );
    });
  }, [artifacts, sessionLabels, trimmedQuery]);

  // Counts come off the searched set, so tab numbers match what a click shows.
  const counts = useMemo(
    () => ({
      all: searched.length,
      images: searched.filter((artifact) => artifact.kind === "image").length,
      files: searched.filter((artifact) => artifact.kind === "file").length,
      links: searched.filter((artifact) => artifact.kind === "link").length,
    }),
    [searched]
  );

  const visible = useMemo(() => {
    const kind = FILTER_KINDS[filter];
    return kind == null
      ? searched
      : searched.filter((artifact) => artifact.kind === kind);
  }, [searched, filter]);

  const openSession = (artifact: SessionArtifact): void => {
    // Start the transcript read before the switch to shorten the empty frame.
    prefetchTranscript(artifact.sessionId);
    activateSelection({
      workspaceId: artifact.workspaceId,
      sessionId: artifact.sessionId,
    });
  };

  /**
   * Open the artifact in its own session's pane, then bring that session on
   * screen, in that order: previews are scoped per conversation and the pane
   * comes forward only for the conversation being shown.
   */
  const showBesideItsSession = (artifact: SessionArtifact): PreviewTarget => {
    const scope = sessionConversationKey(
      artifact.workspaceId,
      artifact.sessionId
    );
    openSession(artifact);
    // Set now so the open below counts as "on screen" before the shell's render.
    setActiveConversationKey(scope);
    return { scope };
  };

  // Two rows are not plain files: the `app` component's artifact is the
  // directory it built, and a deleted or moved file has to say so rather than
  // read as a broken row.
  const openArtifact = async (artifact: SessionArtifact): Promise<void> => {
    setNotice(null);
    if (artifact.kind === "link") {
      openUrlInPreview(artifact.location, showBesideItsSession(artifact));
      return;
    }

    // Tolerate both the marked and unmarked shape of a gone file.
    const extras = artifact as SessionArtifact & {
      missing?: boolean;
      url?: string;
    };
    if (extras.missing === true) {
      setNotice({ id: artifact.id, message: t("artifacts.missingFile") });
      return;
    }

    const separator = artifact.location.lastIndexOf("/");
    const parent =
      separator > 0 ? artifact.location.slice(0, separator) : artifact.location;
    // A one-byte read is the cheapest existence + "is it a file" probe; its
    // errors distinguish gone from directory from unreadable.
    const probe = await window.api.files
      .readFileAsText({
        filePath: artifact.location,
        hostRoot: parent,
        maxBytes: 1,
      })
      .catch(
        () =>
          ({ success: false, error: undefined }) as {
            success: boolean;
            error?: string;
          }
      );

    if (probe.success !== true && probe.error === "not-found") {
      setNotice({ id: artifact.id, message: t("artifacts.missingFile") });
      return;
    }

    if (probe.success !== true && probe.error === "not-a-file") {
      // A directory: open its served page when the record has one, else reveal.
      if (typeof extras.url === "string" && /^https?:\/\//i.test(extras.url)) {
        openUrlInPreview(extras.url, showBesideItsSession(artifact));
        return;
      }
      void window.api.showItemInFolder(artifact.location);
      setNotice({ id: artifact.id, message: t("artifacts.openedFolder") });
      return;
    }

    void openAbsoluteFileInPreview(
      artifact.location,
      undefined,
      showBesideItsSession(artifact)
    );
  };

  const filters: { id: ArtifactFilterId; label: string; count: number }[] = [
    { id: "all", label: t("artifacts.filters.all"), count: counts.all },
    {
      id: "images",
      label: t("artifacts.filters.images"),
      count: counts.images,
    },
    { id: "files", label: t("artifacts.filters.files"), count: counts.files },
    { id: "links", label: t("artifacts.filters.links"), count: counts.links },
  ];

  return (
    <FocusedPage data-id="artifacts-panel">
      <FocusedPageToolbar>
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            placeholder={t("artifacts.searchPlaceholder")}
            aria-label={t("artifacts.searchPlaceholder")}
            data-id="artifacts-search-input"
          />
          {trimmedQuery.length > 0 && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => setQuery("")}
                aria-label={t("workspace.clearSearch")}
                data-id="artifacts-search-clear"
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>

        <ToggleGroup
          value={[filter]}
          onValueChange={(values) => {
            const next = values.at(-1) as ArtifactFilterId | undefined;
            if (next != null) setFilter(next);
          }}
          variant="outline"
          size="sm"
          spacing={0}
          className="max-w-full shrink-0 overflow-x-auto"
          aria-label={t("artifacts.filters.all")}
        >
          {filters.map((entry) => (
            <ToggleGroupItem
              key={entry.id}
              value={entry.id}
              data-id={`artifacts-filter-${entry.id}`}
            >
              {entry.label}
              <span className="text-muted-foreground text-xs tabular-nums">
                {entry.count}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => void artifactsQuery.refetch()}
          aria-label={t("artifacts.refresh")}
          title={t("artifacts.refresh")}
          data-id="artifacts-refresh"
          className="shrink-0"
        >
          <RotateCw
            className={artifactsQuery.isFetching ? "animate-spin" : ""}
          />
        </Button>
      </FocusedPageToolbar>

      {visible.length === 0 ? (
        <Empty className="flex-1" data-id="artifacts-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText />
            </EmptyMedia>
            <EmptyTitle>
              {artifacts.length === 0
                ? t("artifacts.emptyTitle")
                : t("artifacts.noMatchesTitle")}
            </EmptyTitle>
            <EmptyDescription>
              {artifacts.length === 0
                ? t("artifacts.emptyDescription")
                : t("artifacts.noMatchesDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <FocusedPageBody>
          <p
            className="text-muted-foreground pb-2 text-right text-xs tabular-nums"
            data-id="artifacts-count"
          >
            {t("artifacts.itemCount", { count: visible.length })}
          </p>
          <div className="border-border bg-card @container overflow-hidden rounded-lg border">
            <div
              className={`text-muted-foreground/80 ${ROW_GRID} border-border/60 border-b px-4 py-2.5 text-[0.6875rem] font-medium tracking-wider uppercase`}
            >
              <span>{t("artifacts.columns.title")}</span>
              <span className="hidden @2xl:block">
                {t("artifacts.columns.session")}
              </span>
              <span className="sr-only">{t("artifacts.columns.location")}</span>
            </div>
            {visible.map((artifact) => {
              const session = sessionLabels.get(artifact.sessionId);
              return (
                <div
                  key={artifact.id}
                  data-id={`artifact-row-${artifact.id}`}
                  className={`border-border/60 hover:bg-muted/40 group ${ROW_GRID} items-center border-b px-4 py-2 transition-colors last:border-b-0`}
                >
                  <button
                    type="button"
                    onClick={() => void openArtifact(artifact)}
                    title={artifact.title}
                    data-id={`artifact-open-${artifact.id}`}
                    className="flex min-w-0 items-center gap-3 rounded-md py-1 text-start"
                  >
                    {/* A tile rather than a bare glyph: at this row height a
                        loose icon reads as debris beside the title. */}
                    <span className="bg-muted text-muted-foreground group-hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-md transition-colors [&_svg]:size-4">
                      {kindIcon(artifact.kind)}
                    </span>
                    <span className="min-w-0">
                      <span className="text-foreground block truncate text-sm font-medium">
                        {artifact.title}
                      </span>
                      {/* The tail of the path, which is the part that
                          identifies the thing; the rest is in the buttons.
                          Not when it is the title again: an artifact named
                          after its file would say the same thing twice. */}
                      {locationTail(artifact) !== artifact.title && (
                        <span className="text-muted-foreground block truncate font-mono text-xs">
                          {locationTail(artifact)}
                        </span>
                      )}
                      {notice?.id === artifact.id && (
                        <span
                          className="block truncate text-xs text-amber-400"
                          data-id={`artifact-notice-${artifact.id}`}
                        >
                          {notice.message}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openSession(artifact)}
                    data-id={`artifact-session-${artifact.id}`}
                    className="hidden min-w-0 rounded-md py-1 text-start @2xl:block"
                  >
                    <span className="text-muted-foreground hover:text-foreground block truncate text-sm">
                      {session?.label != null && session.label.length > 0
                        ? session.label
                        : t("artifacts.unknownSession")}
                    </span>
                    <ArtifactAgeLabel
                      timestamp={artifact.updatedAt}
                      now={now}
                    />
                  </button>
                  <ArtifactActions artifact={artifact} />
                </div>
              );
            })}
          </div>
        </FocusedPageBody>
      )}
    </FocusedPage>
  );
};
