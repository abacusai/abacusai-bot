/**
 * A parsed .pptx deck as it crosses IPC from the main-process parser to the
 * preview panel. Geometry stays in EMU (914400 per inch, the file format's own
 * unit) so the renderer scales a whole slide by one factor.
 */

export type PptxColor = string;

export type PptxFill =
  | { type: "none" }
  | { type: "solid"; color: PptxColor }
  | {
      type: "gradient";
      angleDeg: number;
      stops: Array<{ color: PptxColor; positionPct: number }>;
    }
  | { type: "image"; dataUrl: string };

export type PptxLine = {
  color: PptxColor;
  widthEmu: number;
  dashed: boolean;
};

export type PptxTextRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sizePt?: number;
  color?: PptxColor;
  fontFamily?: string;
  link?: string;
};

export type PptxParagraph = {
  runs: PptxTextRun[];
  /** Indent level, 0-8. */
  level: number;
  align?: "left" | "center" | "right" | "justify";
  /** Rendered bullet glyph, or null for an unbulleted paragraph. */
  bullet?: string | null;
  bulletColor?: PptxColor;
  /** 1 = single spacing. */
  lineSpacing?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
};

export type PptxTextBody = {
  paragraphs: PptxParagraph[];
  anchor: "top" | "center" | "bottom";
  insets: { left: number; top: number; right: number; bottom: number };
  /** Autofit shrink factor (1 = no shrink). */
  fontScale?: number;
  wrap: boolean;
};

export type PptxTableCell = {
  body: PptxTextBody;
  fill: PptxFill;
  colSpan: number;
  rowSpan: number;
  /** True for cells covered by a merge, kept out of the rendered grid. */
  merged: boolean;
};

export type PptxShapeBase = {
  id: string;
  xEmu: number;
  yEmu: number;
  widthEmu: number;
  heightEmu: number;
  rotationDeg?: number;
  flipH?: boolean;
  flipV?: boolean;
  z: number;
};

export type PptxShape = PptxShapeBase &
  (
    | {
        kind: "shape";
        fill: PptxFill;
        line: PptxLine | null;
        /** Preset geometry name (`rect`, `ellipse`, `roundRect`, …). */
        geometry: string;
        body: PptxTextBody | null;
      }
    | {
        kind: "image";
        dataUrl: string;
        line: PptxLine | null;
        geometry: string;
      }
    | {
        kind: "table";
        columnWidthsEmu: number[];
        rows: Array<{ heightEmu: number; cells: PptxTableCell[] }>;
      }
    | {
        /** Charts, SmartArt, OLE and media, shown as a labelled frame. */
        kind: "placeholder-frame";
        label: string;
        fill: PptxFill;
      }
  );

export type PptxSlide = {
  /** 1-based position in the deck. */
  number: number;
  background: PptxFill;
  /** Inherited from the layout and master; drawn beneath `shapes`. */
  templateShapes: PptxShape[];
  shapes: PptxShape[];
  notes: string | null;
  layoutName: string | null;
  title: string | null;
  hidden: boolean;
};

export type PptxDeck = {
  widthEmu: number;
  heightEmu: number;
  slides: PptxSlide[];
  title: string | null;
  themeName: string | null;
  /** Non-fatal parse problems, surfaced in the viewer's footer. */
  warnings: string[];
};

export type PptxReadResult =
  | { success: true; deck: PptxDeck; sizeBytes: number }
  | { success: false; error: string; sizeBytes?: number };

/** EMU per inch; CSS pixels are 96 per inch. */
export const EMU_PER_INCH = 914400;
export const EMU_PER_PX = EMU_PER_INCH / 96;
export const EMU_PER_POINT = EMU_PER_INCH / 72;
