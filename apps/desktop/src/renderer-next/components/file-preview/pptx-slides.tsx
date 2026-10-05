import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
// Read-only visual slide renderer ported from the legacy PPTX viewer.
import { useTranslation } from "react-i18next";

import {
  EMU_PER_PX,
  type PptxDeck,
  type PptxFill,
  type PptxParagraph,
  type PptxShape,
  type PptxSlide,
  type PptxTextBody,
} from "#shared/pptx";
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

export const PptxSlides = ({ deck }: { deck: PptxDeck }) => {
  const ref = useRef<HTMLOListElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setWidth(entry.contentRect.width);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <ol
      ref={ref}
      className="flex flex-col gap-3"
      data-slot="file-preview-slides"
    >
      {deck.slides.map((slide) => (
        <li key={slide.number} className="overflow-auto">
          <Slide
            slide={slide}
            deck={deck}
            widthPx={width}
            failed={deck.warnings.some(
              (warning) =>
                warning.startsWith(`Slide ${slide.number} could not be read`) ||
                warning.startsWith(
                  `Slide ${slide.number} is missing from the package`
                )
            )}
          />
          {slide.notes && (
            <p className="text-muted-foreground text-xs">{slide.notes}</p>
          )}
        </li>
      ))}
    </ol>
  );
};
