import type { PptxDeck } from "@abacus-ai/contract/pptx";
import { isArtifactPage } from "@abacus-ai/contract/share";
/** Read-only file preview. PPTX uses authored slide geometry; local PDF/HTML
 * URLs come from the caller's host file boundary before the viewer loads. */
import { TextPart } from "@tanstack/ai-react/ui";
import {
  Check,
  Code,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderOpen,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  browserPreview,
  previewBlob,
  previewSize,
  downloadFile,
} from "#platform/preview-files";
import {
  ACTION_BUTTON_CLASS,
  ACTION_ICON_CLASS,
  ACTION_ICON_STROKE,
} from "#renderer/components/message-feedback";
import { highlightFile, toFileUrl } from "#renderer/lib/file-highlight";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import { Skeleton } from "#renderer/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { previewKind } from "./paths";
import { PptxSlides } from "./pptx-slides";

interface FilePreviewReaders {
  text(
    path: string,
    hostRoot: string
  ): Promise<{ content: string; truncated: boolean }>;
  /** A data URL. */
  image(path: string, hostRoot: string): Promise<string>;
  /** The parsed deck (`PptxDeck`); absent: pptx opens externally. */
  pptx?(path: string, hostRoot: string): Promise<unknown>;
  localUrl?(path: string, hostRoot: string): Promise<string>;
}

export interface FilePreviewProps {
  path: string;
  hostRoot: string;
  read: FilePreviewReaders;
  onOpenExternally?(path: string): void;
  onReveal?(path: string): void;
  showActions?: boolean;
  /** The surrounding tab already shows the file name. */
  hideTitle?: boolean;
  initialView?: "source" | "preview";
}

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "binary"; sizeBytes: number }
  | { state: "unsupported" }
  | { state: "text"; content: string; truncated: boolean }
  | { state: "image"; src: string }
  | { state: "slides"; deck: PptxDeck }
  | { state: "local"; url: string };

interface HeaderAction {
  key: string;
  label: string;
  icon: LucideIcon;
  run(): void;
}

/** Below this pane width the header actions collapse into one menu. */
const COMPACT_WIDTH = 240;
const noop = () => undefined;

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export const FilePreview = ({
  path,
  hostRoot,
  read,
  onOpenExternally,
  onReveal,
  showActions = true,
  hideTitle = false,
  initialView = "source",
}: FilePreviewProps) => {
  const { t } = useTranslation();
  const htmlKey = `${path}\u0000${initialView}`;
  const [htmlChoice, setHtmlChoice] = useState<{
    key: string;
    preview: boolean;
  }>();
  const htmlPreview =
    htmlChoice?.key === htmlKey
      ? htmlChoice.preview
      : initialView === "preview";
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setCompact((entry?.contentRect.width ?? COMPACT_WIDTH) < COMPACT_WIDTH)
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const [attempt, setAttempt] = useState(0);
  const [downloadFailure, setDownloadFailure] = useState<string | null>(null);
  const kind =
    previewKind(path) === "pptx" && read.pptx == null
      ? "external"
      : previewKind(path);
  // Keyed by what was read, so a new path shows loading without a reset.
  const key = `${kind}\u0000${hostRoot}\u0000${path}\u0000${attempt}\u0000${htmlPreview}`;
  const downloadError = downloadFailure === key;
  const [result, setResult] = useState<{ key: string; loaded: Loaded }>({
    key: "",
    loaded: { state: "loading" },
  });
  const loaded: Loaded =
    result.key === key ? result.loaded : { state: "loading" };

  const loadFile = useEffectEvent(
    async (signal: AbortSignal): Promise<Loaded> => {
      const input = { filePath: path, hostRoot };
      if (
        browserPreview &&
        kind === "pdf" &&
        navigator.pdfViewerEnabled === false
      )
        return { state: "unsupported" };
      if (browserPreview && kind === "external")
        return { state: "binary", sizeBytes: await previewSize(input, signal) };
      if (
        browserPreview &&
        (kind === "pdf" || (kind === "html" && htmlPreview))
      )
        return {
          state: "local",
          url: await previewBlob(
            input,
            kind === "pdf" ? "application/pdf" : "text/html",
            signal
          ),
        };
      if (!browserPreview && (kind === "pdf" || kind === "html")) {
        if (!read.localUrl)
          throw new Error("Host file URL resolver unavailable");
        const url = new URL(await read.localUrl(path, hostRoot));
        if (url.protocol !== "file:")
          throw new Error("Expected a host file URL");
        return {
          state: "local",
          url: url.hostname
            ? url.href
            : toFileUrl(decodeURIComponent(url.pathname)),
        };
      }
      if (kind === "image")
        return { state: "image", src: await read.image(path, hostRoot) };
      if (kind === "pptx")
        return {
          state: "slides",
          deck: ((await read.pptx!(path, hostRoot)) as { deck: PptxDeck }).deck,
        };
      try {
        return { state: "text", ...(await read.text(path, hostRoot)) };
      } catch (error) {
        if (
          browserPreview &&
          (error as { data?: { reason?: string } }).data?.reason ===
            "binary-file"
        )
          return {
            state: "binary",
            sizeBytes: await previewSize(input, signal),
          };
        throw error;
      }
    }
  );
  useEffect(() => {
    if (kind === "external" && !browserPreview) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    loadFile(abort.signal)
      .then((next) => {
        if (browserPreview && next.state === "local") objectUrl = next.url;
        if (abort.signal.aborted) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        } else setResult({ key, loaded: next });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setResult({ key, loaded: { state: "failed" } });
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, kind]);

  const actions: HeaderAction[] = [];
  if (browserPreview && previewKind(path) === "html")
    actions.push({
      key: "html",
      label: t(htmlPreview ? "web.files.source" : "web.files.preview"),
      icon: htmlPreview ? Code : Eye,
      run: () => setHtmlChoice({ key: htmlKey, preview: !htmlPreview }),
    });
  if (browserPreview)
    actions.push({
      key: "download",
      label: t("web.files.download"),
      icon: Download,
      run: () => {
        setDownloadFailure(null);
        void downloadFile({ filePath: path, hostRoot }).catch(() =>
          setDownloadFailure(key)
        );
      },
    });
  if (showActions) {
    if (onOpenExternally)
      actions.push({
        key: "open",
        label: t("bots.chat.preview.openExternally"),
        icon: ExternalLink,
        run: () => onOpenExternally(path),
      });
    if (onReveal)
      actions.push({
        key: "reveal",
        label: t("bots.chat.deliverables.showInFolder"),
        icon: FolderOpen,
        run: () => onReveal(path),
      });
    if (typeof navigator !== "undefined" && navigator.clipboard)
      actions.push({
        key: "copy",
        label: t(copied ? "artifacts.copied" : "artifacts.copyPath"),
        icon: copied ? Check : Copy,
        run: () =>
          void navigator.clipboard
            .writeText(path)
            .then(() => setCopied(true), noop),
      });
  }
  const name = baseName(path);
  const dir = path.slice(0, path.length - name.length);

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      data-slot="file-preview"
      data-kind={kind}
    >
      {(!hideTitle || actions.length > 0) && (
        <div
          data-slot="file-preview-header"
          className="flex h-9 shrink-0 items-center gap-1 border-b ps-3 pe-1.5"
        >
          {!hideTitle && (
            <span
              className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm"
              title={path}
            >
              <span className="truncate font-medium">{name}</span>
              {dir !== "" && (
                <bdi className="text-muted-foreground min-w-0 truncate text-xs">
                  {dir}
                </bdi>
              )}
            </span>
          )}
          {hideTitle && <span className="flex-1" />}
          {actions.length > 0 &&
            (compact ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className={ACTION_BUTTON_CLASS}
                      aria-label={t("workspace.preview.moreActions")}
                    />
                  }
                >
                  <MoreHorizontal aria-hidden className={ACTION_ICON_CLASS} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {actions.map(({ key: id, label, icon: Icon, run }) => (
                    <DropdownMenuItem key={id} onClick={run}>
                      <Icon aria-hidden />
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="flex shrink-0 items-center gap-0.5">
                {actions.map(({ key: id, label, icon: Icon, run }) => (
                  <Tooltip key={id}>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className={ACTION_BUTTON_CLASS}
                          aria-label={label}
                          onClick={run}
                        />
                      }
                    >
                      <Icon
                        aria-hidden
                        className={ACTION_ICON_CLASS}
                        strokeWidth={ACTION_ICON_STROKE}
                      />
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            ))}
        </div>
      )}
      <div
        className={
          loaded.state === "local"
            ? "flex min-h-0 flex-1 flex-col overflow-hidden text-sm"
            : "min-h-0 flex-1 overflow-auto p-3 text-sm"
        }
      >
        {downloadError && <p role="alert">{t("web.files.downloadFailed")}</p>}
        {kind === "external" && !browserPreview ? (
          <div className="flex flex-col items-start gap-2" role="status">
            <p className="text-muted-foreground">
              {t("bots.chat.preview.noViewer")}
            </p>
            {onOpenExternally && (
              <Button
                variant="secondary"
                onClick={() => onOpenExternally(path)}
              >
                {t("bots.chat.preview.openExternally")}
              </Button>
            )}
          </div>
        ) : loaded.state === "loading" ? (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : loaded.state === "failed" ? (
          <div
            className="flex flex-col items-start gap-2"
            role={browserPreview ? "alert" : "status"}
          >
            <p className="text-muted-foreground">
              {t("bots.chat.preview.failed")}
            </p>
            {browserPreview && (
              <Button
                variant="secondary"
                onClick={() => setAttempt(attempt + 1)}
              >
                {t("sessions.common.retry")}
              </Button>
            )}
            {onOpenExternally && (
              <Button
                variant="secondary"
                onClick={() => onOpenExternally(path)}
              >
                {t("bots.chat.preview.openExternally")}
              </Button>
            )}
          </div>
        ) : loaded.state === "unsupported" ? (
          <div className="flex flex-col items-start gap-2" role="status">
            <p className="text-muted-foreground">
              {t("bots.chat.preview.noViewer")}
            </p>
            {onOpenExternally && (
              <Button
                variant="secondary"
                onClick={() => onOpenExternally(path)}
              >
                {t("bots.chat.preview.openExternally")}
              </Button>
            )}
          </div>
        ) : loaded.state === "binary" ? (
          <div className="flex flex-col items-start gap-2" role="status">
            <p className="text-muted-foreground">
              {t("web.files.binary", {
                size: loaded.sizeBytes.toLocaleString(),
              })}
            </p>
            {onOpenExternally && (
              <Button
                variant="secondary"
                onClick={() => onOpenExternally(path)}
              >
                {t("bots.chat.preview.openExternally")}
              </Button>
            )}
          </div>
        ) : loaded.state === "image" ? (
          <img
            src={loaded.src}
            alt={baseName(path)}
            onError={
              browserPreview
                ? () => setResult({ key, loaded: { state: "failed" } })
                : undefined
            }
            className="mx-auto max-h-full max-w-full object-contain"
          />
        ) : loaded.state === "slides" ? (
          <PptxSlides deck={loaded.deck} />
        ) : loaded.state === "local" ? (
          browserPreview ? (
            <iframe
              title={baseName(path)}
              src={kind === "pdf" ? `${loaded.url}#view=FitH` : loaded.url}
              // Chromium disables its native PDF viewer in sandboxed frames.
              sandbox={
                kind === "pdf"
                  ? undefined
                  : isArtifactPage(path)
                    ? "allow-scripts"
                    : ""
              }
              className="min-h-0 w-full flex-1 border-0 bg-white"
            />
          ) : (
            <webview
              src={kind === "pdf" ? `${loaded.url}#view=FitH` : loaded.url}
              className="min-h-0 w-full flex-1 bg-white"
            />
          )
        ) : (
          <>
            {browserPreview && loaded.content === "" && (
              <p role="status" className="text-muted-foreground">
                {t("web.files.emptyFile")}
              </p>
            )}
            {loaded.truncated && (
              <p className="text-muted-foreground pb-2 text-xs" role="note">
                {t("bots.chat.preview.truncated")}
              </p>
            )}
            {kind === "markdown" ? (
              <TextPart content={loaded.content} role="assistant" />
            ) : (
              <div
                data-slot="file-preview-text"
                className="font-mono text-xs leading-relaxed whitespace-pre-wrap"
                dangerouslySetInnerHTML={{
                  __html: highlightFile(loaded.content, path),
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};
