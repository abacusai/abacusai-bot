import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, StickyNote, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/components/ui/button";
import { workspaceQueryKeys } from "#renderer/lib/query-keys";
import {
  EMU_PER_PX,
  type PptxDeck,
  type PptxFill,
  type PptxParagraph,
  type PptxShape,
  type PptxSlide,
  type PptxTextBody,
} from "#shared/pptx";

/**
 * Renders a parsed .pptx as HTML. Slides are laid out once at their authored
 * pixel size and scaled with a single `transform`; recomputing each shape
 * against the container drifts as soon as font metrics disagree with
 * PowerPoint's, which they always do.
 */

const emuToPx = (emu: number): number => emu / EMU_PER_PX;

/** Font stack behind whatever the deck asked for, so text stays close. */
const FONT_FALLBACK = `system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

const fillToStyle = (fill: PptxFill | undefined): CSSProperties => {
  if (fill == null) return {};
  switch (fill.type) {
    case "solid":
      return { background: fill.color };
    case "gradient":
      return {
        background: `linear-gradient(${fill.angleDeg}deg, ${fill.stops
          .map((stop) => `${stop.color} ${stop.positionPct}%`)
          .join(", ")})`,
      };
    case "image":
      return {
        backgroundImage: `url(${fill.dataUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      };
    default:
      return {};
  }
};

/** The preset geometries worth a distinct shape; the rest read as rectangles. */
const geometryStyle = (geometry: string): CSSProperties => {
  if (geometry === "ellipse" || geometry === "circle")
    return { borderRadius: "50%" };
  if (geometry.startsWith("round")) return { borderRadius: "0.6em" };
  return {};
};

const ANCHOR_TO_JUSTIFY: Record<
  PptxTextBody["anchor"],
  CSSProperties["justifyContent"]
> = {
  top: "flex-start",
  center: "center",
  bottom: "flex-end",
};

const Paragraph = ({
  paragraph,
  scale,
}: {
  paragraph: PptxParagraph;
  scale: number;
}): JSX.Element => {
  const style: CSSProperties = {
    textAlign: paragraph.align ?? "left",
    marginLeft: paragraph.level * 0.35 + "em",
    marginTop: (paragraph.spaceBeforePt ?? 0) * scale,
    marginBottom: (paragraph.spaceAfterPt ?? 0) * scale,
    lineHeight: paragraph.lineSpacing ?? 1.2,
  };

  const runs = paragraph.runs.map((run, index) =>
    run.text === "\n" ? (
      <br key={index} />
    ) : (
      <span
        key={index}
        style={{
          fontWeight: run.bold === true ? 700 : 400,
          fontStyle: run.italic === true ? "italic" : "normal",
          textDecoration:
            [
              run.underline === true ? "underline" : "",
              run.strike === true ? "line-through" : "",
            ]
              .filter(Boolean)
              .join(" ") || "none",
          fontSize: (run.sizePt ?? 18) * scale,
          color: run.color,
          fontFamily:
            run.fontFamily != null
              ? `'${run.fontFamily}', ${FONT_FALLBACK}`
              : FONT_FALLBACK,
        }}
      >
        {run.text}
      </span>
    )
  );

  if (paragraph.bullet == null) {
    return <p style={style}>{runs}</p>;
  }

  // The bullet sits in its own column so wrapped lines align to the text.
  return (
    <p
      style={{
        ...style,
        display: "flex",
        gap: "0.4em",
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          flexShrink: 0,
          color: paragraph.bulletColor ?? paragraph.runs[0]?.color,
        }}
      >
        {paragraph.bullet}
      </span>
      <span style={{ flex: 1, textAlign: paragraph.align ?? "left" }}>
        {runs}
      </span>
    </p>
  );
};

const TextBody = ({
  body,
  scale,
}: {
  body: PptxTextBody;
  scale: number;
}): JSX.Element => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      justifyContent: ANCHOR_TO_JUSTIFY[body.anchor],
      paddingLeft: emuToPx(body.insets.left),
      paddingRight: emuToPx(body.insets.right),
      paddingTop: emuToPx(body.insets.top),
      paddingBottom: emuToPx(body.insets.bottom),
      whiteSpace: body.wrap ? "pre-wrap" : "pre",
      overflow: "hidden",
    }}
  >
    {body.paragraphs.map((paragraph, index) => (
      <Paragraph
        key={index}
        paragraph={paragraph}
        scale={scale * (body.fontScale ?? 1)}
      />
    ))}
  </div>
);

const Shape = ({ shape }: { shape: PptxShape }): JSX.Element | null => {
  const frame: CSSProperties = {
    position: "absolute",
    left: emuToPx(shape.xEmu),
    top: emuToPx(shape.yEmu),
    width: emuToPx(shape.widthEmu),
    height: emuToPx(shape.heightEmu),
    transform:
      [
        shape.rotationDeg != null && shape.rotationDeg !== 0
          ? `rotate(${shape.rotationDeg}deg)`
          : "",
        shape.flipH === true ? "scaleX(-1)" : "",
        shape.flipV === true ? "scaleY(-1)" : "",
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };

  // Points per pixel: text is sized in points, the slide is laid out in pixels.
  const textScale = 96 / 72;

  switch (shape.kind) {
    case "image":
      return (
        <img
          src={shape.dataUrl}
          alt=""
          style={{
            ...frame,
            ...geometryStyle(shape.geometry),
            // PowerPoint stretches a picture to its frame, ignoring aspect ratio.
            objectFit: "fill",
            border:
              shape.line != null
                ? `${emuToPx(shape.line.widthEmu)}px solid ${shape.line.color}`
                : undefined,
          }}
        />
      );

    case "table": {
      const totalWidth = shape.columnWidthsEmu.reduce(
        (sum, width) => sum + width,
        0
      );
      return (
        <div style={frame}>
          <table
            style={{
              width: "100%",
              height: "100%",
              borderCollapse: "collapse",
              tableLayout: "fixed",
            }}
          >
            <colgroup>
              {shape.columnWidthsEmu.map((width, index) => (
                <col
                  key={index}
                  style={{
                    width: `${totalWidth > 0 ? (width / totalWidth) * 100 : 0}%`,
                  }}
                />
              ))}
            </colgroup>
            <tbody>
              {shape.rows.map((row, rowIndex) => (
                <tr key={rowIndex} style={{ height: emuToPx(row.heightEmu) }}>
                  {row.cells
                    .filter((cell) => !cell.merged)
                    .map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                        rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                        style={{
                          ...fillToStyle(cell.fill),
                          border: "1px solid rgba(127,127,127,0.45)",
                          position: "relative",
                          verticalAlign: "middle",
                          padding: 0,
                        }}
                      >
                        <TextBody body={cell.body} scale={textScale} />
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case "placeholder-frame":
      return (
        <div
          style={{
            ...frame,
            ...fillToStyle(shape.fill),
            border: "1px dashed rgba(127,127,127,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(127,127,127,0.85)",
            fontSize: 14,
            fontFamily: FONT_FALLBACK,
          }}
        >
          {shape.label}
        </div>
      );

    default:
      return (
        <div
          style={{
            ...frame,
            ...fillToStyle(shape.fill),
            ...geometryStyle(shape.geometry),
            border:
              shape.line != null
                ? `${Math.max(1, emuToPx(shape.line.widthEmu))}px ${shape.line.dashed ? "dashed" : "solid"} ${shape.line.color}`
                : undefined,
          }}
        >
          {shape.body != null && (
            <TextBody body={shape.body} scale={textScale} />
          )}
        </div>
      );
  }
};

/** One slide at its authored pixel size inside a box scaled to the width. */
const Slide = ({
  slide,
  deck,
  widthPx,
  failed = false,
}: {
  slide: PptxSlide;
  deck: PptxDeck;
  widthPx: number;
  /** The parser could not read this slide; it is blank, not empty by design. */
  failed?: boolean;
}): JSX.Element => {
  const { t } = useTranslation();
  const designWidth = emuToPx(deck.widthEmu);
  const designHeight = emuToPx(deck.heightEmu);
  const scale = widthPx / designWidth;

  return (
    <div
      style={{
        width: widthPx,
        height: designHeight * scale,
        position: "relative",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: designWidth,
          height: designHeight,
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          ...fillToStyle(slide.background),
        }}
      >
        {slide.templateShapes.map((shape, index) => (
          <Shape key={`t-${shape.id}-${index}`} shape={shape} />
        ))}
        {slide.shapes.map((shape, index) => (
          <Shape key={`s-${shape.id}-${index}`} shape={shape} />
        ))}
      </div>
      {failed && (
        // Drawn in the scaled box so the label stays readable in the rail too.
        <div
          data-id={`pptx-slide-failed-${slide.number}`}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: 8,
            textAlign: "center",
            background: "rgba(245, 158, 11, 0.12)",
            border: "2px dashed rgba(245, 158, 11, 0.75)",
            color: "rgb(180, 83, 9)",
            fontFamily: FONT_FALLBACK,
            fontSize: Math.max(9, Math.min(15, widthPx / 26)),
            fontWeight: 600,
          }}
        >
          {t("workspace.preview.pptxSlideFailed", {
            number: slide.number,
            defaultValue: "Slide {{number}} could not be rendered",
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Slides the parser gave up on: it pushes a blank slide in their place, which
 * otherwise renders as a convincing empty white slide.
 */
const FAILED_SLIDE_PATTERN =
  /^Slide (\d+) (?:could not be read|is missing from the package)/;

const failedSlideNumbers = (warnings: string[]): Set<number> => {
  const failed = new Set<number>();
  for (const warning of warnings) {
    const match = FAILED_SLIDE_PATTERN.exec(warning);
    if (match?.[1] != null) failed.add(Number(match[1]));
  }
  return failed;
};

export const PptxViewer = ({
  filePath,
  hostRoot,
  version,
}: {
  filePath: string;
  hostRoot: string;
  /**
   * Bumped every time the deck is opened: the parse is cached by path, so a
   * re-preview of a deck the agent just rewrote would replay the old slides.
   */
  version?: number;
}): JSX.Element => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [activeSlide, setActiveSlide] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  const deckQuery = useQuery({
    queryKey: workspaceQueryKeys.previewPptx(filePath, version),
    staleTime: 30_000,
    // A parsed deck inlines every image as base64, the heaviest thing this app
    // holds in memory; release it soon after the reader navigates away.
    gcTime: 30_000,
    queryFn: async () => window.api.files.readPptx({ filePath, hostRoot }),
  });

  // The stage is measured rather than assumed.
  useEffect(() => {
    const element = stageRef.current;
    if (element == null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setStageWidth(Math.max(0, width - 32));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [deckQuery.data]);

  const deck = deckQuery.data?.success === true ? deckQuery.data.deck : null;

  const slideRefs = useRef<Array<HTMLDivElement | null>>([]);

  const scrollToSlide = useCallback((index: number) => {
    slideRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (deck == null) return;
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "PageDown" &&
        event.key !== "PageUp"
      ) {
        return;
      }
      const forward = event.key === "ArrowDown" || event.key === "PageDown";
      const next = Math.min(
        deck.slides.length - 1,
        Math.max(0, activeSlide + (forward ? 1 : -1))
      );
      if (next !== activeSlide) {
        event.preventDefault();
        scrollToSlide(next);
      }
    },
    [deck, activeSlide, scrollToSlide]
  );

  // Which slide is showing drives both the rail highlight and the notes pane.
  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (container == null) return;
    const midpoint = container.scrollTop + container.clientHeight / 2;
    let index = 0;
    slideRefs.current.forEach((node, slideIndex) => {
      if (node != null && node.offsetTop <= midpoint) index = slideIndex;
    });
    setActiveSlide(index);
  }, []);

  const notes = deck?.slides[activeSlide]?.notes ?? null;
  const thumbWidth = 132;

  const warnings = useMemo(() => deck?.warnings ?? [], [deck]);
  const failedSlides = useMemo(() => failedSlideNumbers(warnings), [warnings]);
  // One unreadable slide already misrepresents the deck; no majority needed.
  const showWarningBanner = failedSlides.size > 0 && !warningsDismissed;

  if (deckQuery.isPending) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-xs">
        <Loader2 size={14} className="animate-spin" />
        {t("workspace.preview.loading")}
      </div>
    );
  }

  if (deck == null) {
    const error =
      deckQuery.data?.success === false ? deckQuery.data.error : "unknown";
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="border-border text-muted-foreground rounded-md border px-3 py-2 text-center text-sm">
          {t("workspace.preview.pptxError", { error })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-id="pptx-viewer">
      {showWarningBanner && (
        <div
          data-id="pptx-warning-banner"
          className="flex shrink-0 items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {t("workspace.preview.pptxSlidesFailed", {
                failed: failedSlides.size,
                total: deck.slides.length,
                defaultValue:
                  "{{failed}} of {{total}} slides could not be rendered",
              })}
            </div>
            <ul className="mt-0.5 space-y-0.5 opacity-90">
              {warnings.slice(0, 4).map((warning, index) => (
                <li key={index} className="truncate">
                  {warning}
                </li>
              ))}
              {warnings.length > 4 && (
                <li>
                  {t("workspace.preview.pptxMoreWarnings", {
                    count: warnings.length - 4,
                    defaultValue: "+{{count}} more",
                  })}
                </li>
              )}
            </ul>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            data-id="pptx-warning-dismiss"
            onClick={() => setWarningsDismissed(true)}
            className="shrink-0"
            aria-label={t("common.close")}
          >
            <X />
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Thumbnail rail */}
        <div
          className="border-border bg-sidebar shrink-0 overflow-y-auto border-r p-2"
          style={{ width: thumbWidth + 24 }}
          data-id="pptx-thumbnails"
        >
          {deck.slides.map((slide, index) => (
            <Button
              key={slide.number}
              variant="outline"
              data-id={`pptx-thumb-${slide.number}`}
              onClick={() => scrollToSlide(index)}
              className={`mb-2 h-auto w-full flex-col items-stretch gap-0 p-1 text-left whitespace-normal ${
                index === activeSlide ? "border-primary bg-primary/10" : ""
              }`}
            >
              <div className="border-border pointer-events-none overflow-hidden rounded-sm border">
                <Slide
                  slide={slide}
                  deck={deck}
                  widthPx={thumbWidth}
                  failed={failedSlides.has(slide.number)}
                />
              </div>
              <div className="mt-1 flex items-baseline gap-1">
                <span className="text-muted-foreground text-[0.625rem]">
                  {slide.number}
                </span>
                <span className="text-secondary-foreground truncate text-[0.625rem]">
                  {slide.title ?? ""}
                </span>
              </div>
            </Button>
          ))}
        </div>

        {/* Slides */}
        <div
          ref={(node) => {
            scrollRef.current = node;
            stageRef.current = node;
          }}
          onScroll={onScroll}
          onKeyDown={handleKeyDown}
          tabIndex={0}
          className="bg-muted min-w-0 flex-1 overflow-y-auto p-4 outline-none"
          data-id="pptx-stage"
        >
          {deck.slides.map((slide, index) => (
            <div
              key={slide.number}
              ref={(node) => {
                slideRefs.current[index] = node;
              }}
              className="mx-auto mb-4 shadow-lg"
              style={{ width: stageWidth > 0 ? stageWidth : undefined }}
            >
              {stageWidth > 0 && (
                <Slide
                  slide={slide}
                  deck={deck}
                  widthPx={stageWidth}
                  failed={failedSlides.has(slide.number)}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Speaker notes */}
      {showNotes && (
        <div className="border-border bg-sidebar text-secondary-foreground max-h-40 shrink-0 overflow-y-auto border-t px-4 py-2 text-xs whitespace-pre-wrap">
          {notes ?? (
            <span className="text-muted-foreground">
              {t("workspace.preview.pptxNoNotes")}
            </span>
          )}
        </div>
      )}

      {/* Status bar */}
      <div className="border-border text-muted-foreground flex shrink-0 items-center gap-3 border-t px-3 py-1 text-[0.625rem]">
        <span>
          {t("workspace.preview.pptxSlideCount", {
            current: activeSlide + 1,
            total: deck.slides.length,
          })}
        </span>
        {deck.themeName != null && (
          <span className="truncate">{deck.themeName}</span>
        )}
        <Button
          variant="ghost"
          size="xs"
          data-id="pptx-toggle-notes"
          onClick={() => setShowNotes((value) => !value)}
          className={showNotes ? "text-primary ml-auto" : "ml-auto"}
        >
          <StickyNote />
          {t("workspace.preview.pptxNotes")}
        </Button>
        {warnings.length > 0 && (
          <span title={warnings.join("\n")} className="text-amber-500">
            {t("workspace.preview.pptxWarnings", { count: warnings.length })}
          </span>
        )}
      </div>
    </div>
  );
};
