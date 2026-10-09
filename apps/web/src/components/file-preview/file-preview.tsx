import type { PptxDeck } from "@abacus-ai/contract/pptx";
/** Read-only file preview. PPTX uses authored slide geometry; local PDF/HTML
 * URLs come from the caller's host file boundary before the viewer loads. */
import { TextPart } from "@tanstack/ai-react/ui";
import { ExternalLink, FolderOpen } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  browserPreview,
  previewBlob,
  previewSize,
  downloadFile,
} from "#platform/preview-files";
import { highlightFile, toFileUrl } from "#renderer/lib/file-highlight";
import { Button } from "#renderer/ui/button";
import { Skeleton } from "#renderer/ui/skeleton";

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
  initialView?: "source" | "preview";
}

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "binary"; sizeBytes: number }
  | { state: "text"; content: string; truncated: boolean }
  | { state: "image"; src: string }
  | { state: "slides"; deck: PptxDeck }
  | { state: "local"; url: string };

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export const FilePreview = ({
  path,
  hostRoot,
  read,
  onOpenExternally,
  onReveal,
  showActions = true,
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

  const actions = (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      {browserPreview && (
        <>
          {previewKind(path) === "html" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setHtmlChoice({ key: htmlKey, preview: !htmlPreview })
              }
            >
              {t(htmlPreview ? "web.files.source" : "web.files.preview")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDownloadFailure(null);
              void downloadFile({ filePath: path, hostRoot }).catch(() =>
                setDownloadFailure(key)
              );
            }}
          >
            {t("web.files.download")}
          </Button>
        </>
      )}
      {onReveal != null && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("bots.chat.deliverables.showInFolder")}
          onClick={() => onReveal(path)}
        >
          <FolderOpen />
        </Button>
      )}
      {onOpenExternally && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("bots.chat.preview.openExternally")}
          onClick={() => onOpenExternally?.(path)}
        >
          <ExternalLink />
        </Button>
      )}
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-slot="file-preview"
      data-kind={kind}
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="w-full truncate text-sm font-medium" title={path}>
          {baseName(path)}
        </span>
        {(showActions || browserPreview) && actions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-sm">
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
        ) : loaded.state === "binary" ? (
          <p role="status" className="text-muted-foreground">
            {t("web.files.binary", { size: loaded.sizeBytes.toLocaleString() })}
          </p>
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
              src={loaded.url}
              // Chromium disables its native PDF viewer in sandboxed frames.
              sandbox={kind === "pdf" ? undefined : ""}
              className="h-full min-h-[320px] w-full bg-white"
            />
          ) : (
            <webview src={loaded.url} className="h-[600px] w-full bg-white" />
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
