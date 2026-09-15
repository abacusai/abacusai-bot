import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Globe } from "lucide-react";
import { lazy, Suspense, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { ConversationKey } from "#shared/conversation-scope";

import { getBrowserHomepage } from "../../lib/browser-homepage";
import { openPreviewTab } from "../../lib/preview-tabs";
import { workspaceQueryKeys } from "../../lib/query-keys";
import {
  useWorkspaceActiveWorkspaceId,
  useWorkspaceMetadata,
} from "../../providers/workspace-state-provider";
import { usePreviewItem, type PreviewItem } from "../../stores/preview-store";
import { openLocalFile } from "../../utils/open-local-file";
import { containmentRootFor } from "../../utils/preview-utils";
import { getPathSegmentName } from "../../utils/workspace-state";
import { AbacusBotLogo } from "../brand/abacus-bot-logo";
import { Markdown } from "../common/markdown";
import { Button, Spinner } from "../ui";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

const MonacoFileEditor = lazy(() =>
  import("../workspace/monaco-file-editor").then((m) => ({
    default: m.MonacoFileEditor,
  }))
);

// The deck renderer is only worth loading once someone opens a .pptx.
const PptxViewer = lazy(() =>
  import("./pptx-viewer").then((m) => ({ default: m.PptxViewer }))
);

// Empty state

const EmptyState = ({
  onOpenBrowser,
}: {
  onOpenBrowser: () => void;
}): JSX.Element => {
  const { t } = useTranslation();

  return (
    <Empty className="h-full" data-id="preview-empty-state">
      <EmptyHeader>
        <EmptyMedia>
          <AbacusBotLogo className="opacity-30" data-id="preview-empty-logo" />
        </EmptyMedia>
        <EmptyTitle>{t("workspace.preview.emptyTitle")}</EmptyTitle>
        <EmptyDescription>
          {t("workspace.preview.emptyDescription")}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          size="lg"
          data-id="preview-open-browser"
          onClick={onOpenBrowser}
        >
          <Globe />
          {t("workspace.preview.openBrowser")}
        </Button>
      </EmptyContent>
    </Empty>
  );
};

const ignoreEditorChange = (_content: string): void => {};

const FileContent = ({ item }: { item: PreviewItem }): JSX.Element => {
  const { t } = useTranslation();
  const filename = item.location.split("/").pop() ?? item.location;

  return (
    <Suspense
      fallback={
        <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
          {t("workspace.fileEditor.loading")}
        </div>
      }
    >
      <MonacoFileEditor
        filePath={item.fileAbsPath ?? item.location}
        filename={filename}
        content={item.fileContent ?? ""}
        readOnly
        onSave={ignoreEditorChange}
        onChange={ignoreEditorChange}
      />
    </Suspense>
  );
};

// Rendered documents (pptx, pdf, html)

/**
 * `file://` URL for a path. Windows separators become forward slashes and the
 * drive letter keeps its colon: `C%3A` is not a drive to Chromium.
 */
const toFileUrl = (absPath: string): string => {
  const normalized = absPath.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((segment) =>
      /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join("/");
  // A POSIX path already starts with '/' (empty authority); Windows needs one.
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
};

/**
 * An image the agent produced, shown in the pane over the same data-url IPC
 * the transcript uses. The OS viewer stays as the fallback when the IPC
 * refuses the read (unsupported extension, too large, outside the root).
 */
const ImageContent = ({
  absPath,
  hostRoot,
  version,
}: {
  absPath: string;
  hostRoot: string;
  version?: number;
}): JSX.Element => {
  const { t } = useTranslation();
  const imageQuery = useQuery({
    queryKey: workspaceQueryKeys.previewImage(absPath, version),
    staleTime: 10_000,
    // Base64 payloads are large; don't hold them long after the reader moves on.
    gcTime: 60_000,
    queryFn: async () =>
      window.api.files.readImageAsDataUrl({ filePath: absPath, hostRoot }),
  });

  const failed =
    !imageQuery.isPending &&
    (imageQuery.error != null || imageQuery.data?.success !== true);

  if (imageQuery.isPending) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-xs">
        <Spinner fontSize={14} />
        {t("workspace.preview.loading")}
      </div>
    );
  }

  if (failed) {
    const error =
      imageQuery.error != null
        ? String((imageQuery.error as Error).message ?? imageQuery.error)
        : (imageQuery.data?.error ?? "unknown");
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 px-6"
        data-id="preview-image-error"
      >
        <div className="border-border text-muted-foreground max-w-md rounded-md border px-3 py-2 text-center text-xs">
          {error === "outside-root"
            ? t("workspace.preview.imageOutsideWorkspace")
            : t("workspace.preview.imageError", {
                error,
                defaultValue: `Could not show this image here ({{error}}).`,
              })}
        </div>
        <Button
          variant="outline"
          size="sm"
          data-id="preview-image-open-external"
          onClick={() => void openLocalFile(absPath)}
        >
          <ExternalLink size={13} />
          {t("workspace.preview.openExternal")}
        </Button>
      </div>
    );
  }

  return (
    // A flat mid ground reads honestly with and without transparency.
    <div
      className="bg-muted flex h-full w-full items-center justify-center overflow-auto p-4"
      data-id="preview-image"
    >
      <img
        src={imageQuery.data?.dataUrl}
        alt={getPathSegmentName(absPath)}
        className="max-h-full max-w-full object-contain"
        style={{ imageRendering: "auto" }}
      />
    </div>
  );
};

// Main PreviewPanel

export const PreviewPanel = ({
  scope,
  tabId,
}: {
  /** The conversation whose pane this is; it shows that chat's tabs only. */
  scope: ConversationKey;
  /** The tab the right panel has active; null when it is not a preview. */
  tabId: string | null;
}): JSX.Element => {
  const { t } = useTranslation();
  const item = usePreviewItem(scope, tabId);
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const metadataQuery = useWorkspaceMetadata();
  const activeWorkspacePath =
    metadataQuery.data?.workspaces.find(
      (workspace) => workspace.id === activeWorkspaceId
    )?.path ?? null;

  if (item == null) {
    return (
      <EmptyState
        onOpenBrowser={() =>
          openPreviewTab(scope, {
            type: "url",
            location: getBrowserHomepage(),
            title: "Browser",
          })
        }
      />
    );
  }

  // Browser resources have their own native WebContentsView surface.
  if (item.type === "url") return <></>;

  return (
    <div className="flex h-full flex-col" data-id="preview-panel">
      {item.truncated === true && (
        <div
          data-id="preview-truncated-banner"
          className="flex shrink-0 items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span className="min-w-0">
            {t("workspace.preview.truncatedFile", {
              defaultValue:
                "This file is too large to show in full. Only the beginning is displayed.",
            })}
          </span>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {item.type === "pptx" ? (
          <Suspense
            fallback={
              <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                {t("workspace.preview.loading")}
              </div>
            }
          >
            <PptxViewer
              key={`${item.location}-${item.openedAt ?? 0}`}
              filePath={item.fileAbsPath ?? item.location}
              hostRoot={containmentRootFor(
                item.fileAbsPath ?? item.location,
                activeWorkspacePath
              )}
              version={item.openedAt}
            />
          </Suspense>
        ) : item.type === "image" ? (
          <ImageContent
            key={`${item.location}-${item.openedAt ?? 0}`}
            absPath={item.fileAbsPath ?? item.location}
            hostRoot={containmentRootFor(
              item.fileAbsPath ?? item.location,
              activeWorkspacePath
            )}
            version={item.openedAt}
          />
        ) : item.type === "pdf" || item.type === "html" ? (
          <webview
            key={`${item.location}-render-${item.openedAt ?? 0}`}
            src={toFileUrl(item.fileAbsPath ?? item.location)}
            className="h-full w-full bg-white"
          />
        ) : item.type === "md" ? (
          <div
            key={`${item.location}-rendered-${item.openedAt ?? 0}`}
            data-id="preview-md-rendered"
            className="prose0 h-full overflow-y-auto px-5 py-4 text-xs leading-relaxed"
          >
            <Markdown
              content={item.fileContent ?? ""}
              className="prose dark:prose-invert text-foreground max-w-none"
            />
          </div>
        ) : (
          <FileContent
            key={`${item.location}-${item.openedAt ?? 0}`}
            item={item}
          />
        )}
      </div>
    </div>
  );
};
