/** Read-only file preview. PPTX uses authored slide geometry; local PDF/HTML
 * URLs come from the caller's host file boundary before the viewer loads. */
import { TextPart } from "@tanstack/ai-react/ui";
import { ExternalLink, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { highlightFile, toFileUrl } from "#renderer/lib/file-highlight";
import { Button } from "#renderer/ui/button";
import { Skeleton } from "#renderer/ui/skeleton";
import type { PptxDeck } from "#shared/pptx";

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
  onOpenExternally(path: string): void;
  onReveal?(path: string): void;
}

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
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
}: FilePreviewProps) => {
  const { t } = useTranslation();
  const kind =
    previewKind(path) === "pptx" && read.pptx == null
      ? "external"
      : previewKind(path);
  // Keyed by what was read, so a new path shows loading without a reset.
  const key = `${kind}\u0000${hostRoot}\u0000${path}`;
  const [result, setResult] = useState<{ key: string; loaded: Loaded }>({
    key: "",
    loaded: { state: "loading" },
  });
  const loaded: Loaded =
    result.key === key ? result.loaded : { state: "loading" };

  useEffect(() => {
    if (kind === "external") return;
    let live = true;
    const load = async (): Promise<Loaded> => {
      if (kind === "pdf" || kind === "html") {
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
      const text = await read.text(path, hostRoot);
      return { state: "text", ...text };
    };
    load()
      .then((next) => live && setResult({ key, loaded: next }))
      .catch(() => live && setResult({ key, loaded: { state: "failed" } }));
    return () => {
      live = false;
    };
  }, [key, kind, path, hostRoot, read]);

  const actions = (
    <div className="flex shrink-0 items-center gap-1">
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
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("bots.chat.preview.openExternally")}
        onClick={() => onOpenExternally(path)}
      >
        <ExternalLink />
      </Button>
    </div>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-slot="file-preview"
      data-kind={kind}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={path}
        >
          {baseName(path)}
        </span>
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-sm">
        {kind === "external" ? (
          <div className="flex flex-col items-start gap-2" role="status">
            <p className="text-muted-foreground">
              {t("bots.chat.preview.noViewer")}
            </p>
            <Button variant="secondary" onClick={() => onOpenExternally(path)}>
              {t("bots.chat.preview.openExternally")}
            </Button>
          </div>
        ) : loaded.state === "loading" ? (
          <div className="flex flex-col gap-2" aria-busy>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : loaded.state === "failed" ? (
          <div className="flex flex-col items-start gap-2" role="status">
            <p className="text-muted-foreground">
              {t("bots.chat.preview.failed")}
            </p>
            <Button variant="secondary" onClick={() => onOpenExternally(path)}>
              {t("bots.chat.preview.openExternally")}
            </Button>
          </div>
        ) : loaded.state === "image" ? (
          <img
            src={loaded.src}
            alt={baseName(path)}
            className="mx-auto max-h-full max-w-full object-contain"
          />
        ) : loaded.state === "slides" ? (
          <PptxSlides deck={loaded.deck} />
        ) : loaded.state === "local" ? (
          <webview src={loaded.url} className="h-[600px] w-full bg-white" />
        ) : (
          <>
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
