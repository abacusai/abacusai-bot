/**
 * A read-only preview of one file (spec 03 §11.3a; the old preview pane's
 * renderers, no editor): images, Markdown rendered, code and text as
 * monospace, a pptx deck as its slides' text. Anything without an in-app
 * viewer (office documents, binaries, pdf and html until their renderers
 * are ported) offers the OS app instead. Props in, callbacks out: the caller
 * supplies the reads (`files.readText`, `files.readImageAsDataUrl`,
 * `files.readPptx`).
 */
import { TextPart } from "@tanstack/ai-react/ui";
import { ExternalLink, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { highlightFile, toFileUrl } from "#next/lib/file-highlight";
import { Button } from "#next/ui/button";
import { Skeleton } from "#next/ui/skeleton";

import { previewKind } from "./paths";

export interface FilePreviewReaders {
  text(
    path: string,
    hostRoot: string
  ): Promise<{ content: string; truncated: boolean }>;
  /** A data URL. */
  image(path: string, hostRoot: string): Promise<string>;
  /** The parsed deck (`PptxDeck`); absent: pptx opens externally. */
  pptx?(path: string, hostRoot: string): Promise<unknown>;
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
  | { state: "slides"; slides: string[][] };

/** Every text run of a slide, in reading order (a cheap outline view). */
const slideTexts = (deck: unknown): string[][] => {
  const parsed = (deck as { deck?: unknown } | null)?.deck ?? deck;
  const slides = (parsed as { slides?: unknown[] } | null)?.slides ?? [];
  return slides.map((slide) => {
    const lines: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (node == null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.runs)) {
        const line = (record.runs as Array<{ text?: string }>)
          .map((run) => run.text ?? "")
          .join("")
          .trim();
        if (line !== "") lines.push(line);
        return;
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(slide);
    return lines;
  });
};

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
    if (kind === "external" || kind === "pdf" || kind === "html") return;
    let live = true;
    const load = async (): Promise<Loaded> => {
      if (kind === "image")
        return { state: "image", src: await read.image(path, hostRoot) };
      if (kind === "pptx")
        return {
          state: "slides",
          slides: slideTexts(await read.pptx!(path, hostRoot)),
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
        {kind === "pdf" || kind === "html" ? (
          <webview
            src={toFileUrl(path)}
            className="h-[600px] w-full bg-white"
          />
        ) : kind === "external" ? (
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
          <ol className="flex flex-col gap-3" data-slot="file-preview-slides">
            {loaded.slides.map((lines, index) => (
              <li key={index} className="bg-muted/40 rounded-lg p-3">
                <div className="text-muted-foreground pb-1 text-xs">
                  {t("bots.chat.preview.slide", { n: index + 1 })}
                </div>
                {lines.map((line, row) => (
                  <p key={row}>{line}</p>
                ))}
              </li>
            ))}
          </ol>
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
