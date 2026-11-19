/**
 * Word from the same source as the PDF. Round 1: every .docx was a model-written
 * script, so heading styles were hit and miss (one report was 7 layout tables
 * and no headings), and "Word and PDF" printed the PDF with tools a user's
 * machine lacks. Here the printed HTML is walked once into blocks (in the
 * window), and the .docx is built from them in code with real heading styles,
 * lists and tables.
 */
import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

export type Run = { text: string; bold?: boolean; italic?: boolean };
export type Block =
  | { t: "h"; level: 1 | 2 | 3; runs: Run[] }
  | {
      t: "p";
      runs: Run[];
      kind?: "kicker" | "lead" | "callout" | "small" | "right" | "letterhead";
      keep?: boolean;
    }
  /** `list` tells one list from the next, so each is numbered from 1. */
  | { t: "li"; runs: Run[]; ordered: boolean; level: number; list?: number }
  /**
   * A chart or the user's picture, shot from the printed page by the make
   * step (the element carries data-shot="<shot>"); a chart that could not be
   * shot falls back to its numbers.
   */
  | {
      t: "picture";
      shot: number;
      alt?: string;
      values?: Array<[string, number]>;
      data?: Uint8Array;
      w?: number;
      h?: number;
    }
  | {
      t: "table";
      rows: Array<{ header: boolean; cells: Run[][]; total?: boolean }>;
    }
  | { t: "break" }
  /** A running header the page asks for (`.running`): Word's page header. */
  | { t: "running"; text: string };

/** In the window: the document as blocks. Self-contained (serialised). */
export function collectBlocks(doc: Document): Block[] {
  const out: Block[] = [];
  let lists = 0;
  let shots = 0;
  const picture = (
    el: Element,
    extra: { alt?: string; values?: Array<[string, number]> }
  ): void => {
    const shot = shots++;
    el.setAttribute("data-shot", String(shot));
    out.push({ t: "picture", shot, ...extra });
  };
  const runsOf = (el: Node, bold = false, italic = false): Run[] => {
    const runs: Run[] = [];
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        const text = (n.textContent || "").replace(/\s+/g, " ");
        if (text.trim() !== "" || (text === " " && runs.length > 0))
          runs.push({ text, bold, italic });
      } else if (n.nodeType === 1) {
        const e = n as Element;
        const tag = e.tagName.toLowerCase();
        if (tag === "br") runs.push({ text: "\n" });
        else if (tag === "svg" || tag === "style" || tag === "script") return;
        else
          runs.push(
            ...runsOf(
              e,
              bold ||
                tag === "b" ||
                tag === "strong" ||
                e.classList.contains("value"),
              italic || tag === "i" || tag === "em"
            )
          );
      }
    });
    return runs;
  };
  const trimRuns = (runs: Run[]): Run[] => {
    if (runs.length === 0) return runs;
    runs[0] = { ...runs[0]!, text: runs[0]!.text.replace(/^\s+/, "") };
    const last = runs.length - 1;
    runs[last] = { ...runs[last]!, text: runs[last]!.text.replace(/\s+$/, "") };
    return runs.filter((r) => r.text !== "");
  };
  const BLOCK =
    /^(div|section|article|header|footer|main|aside|figure|ul|ol|table|p|h1|h2|h3|h4|blockquote|fieldset)$/;
  const hasBlockChild = (el: Element): boolean =>
    Array.from(el.children).some((c) => BLOCK.test(c.tagName.toLowerCase()));
  const list = (el: Element, ordered: boolean, level: number): void => {
    const id = ++lists;
    for (const li of Array.from(el.children).filter(
      (c) => c.tagName.toLowerCase() === "li"
    )) {
      const inner = Array.from(li.children).filter((c) =>
        /^(ul|ol)$/.test(c.tagName.toLowerCase())
      );
      const clone = li.cloneNode(true) as Element;
      clone.querySelectorAll("ul,ol").forEach((x) => x.remove());
      out.push({
        t: "li",
        runs: trimRuns(runsOf(clone)),
        ordered,
        level,
        list: id,
      });
      for (const sub of inner)
        list(sub, sub.tagName.toLowerCase() === "ol", level + 1);
    }
  };
  const looseText = (n: Node): void => {
    const text = (n.nodeType === 3 ? n.textContent || "" : "")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") out.push({ t: "p", runs: [{ text }] });
  };
  const walk = (el: Element): void => {
    const tag = el.tagName.toLowerCase();
    const cls = el.classList;
    if (tag === "style" || tag === "script" || tag === "svg") return;
    if (cls.contains("running")) {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text !== "") out.push({ t: "running", text });
      return;
    }
    if (/^h[1-4]$/.test(tag)) {
      out.push({
        t: "h",
        level: Math.min(3, Number(tag[1])) as 1 | 2 | 3,
        runs: trimRuns(runsOf(el)),
      });
      return;
    }
    if (tag === "ul" || tag === "ol") {
      list(el, tag === "ol", 0);
      return;
    }
    if (tag === "table") {
      const rows = Array.from(el.querySelectorAll("tr")).map((tr) => ({
        header:
          tr.querySelector("th") != null && tr.querySelector("td") == null,
        total:
          tr.getAttribute("data-role") === "total" ||
          tr.classList.contains("total"),
        cells: Array.from(tr.children).map((c) => trimRuns(runsOf(c))),
      }));
      out.push({ t: "table", rows });
      return;
    }
    if (tag === "img") {
      picture(el, { alt: (el.getAttribute("alt") ?? "").trim() });
      return;
    }
    if (tag === "figure" && !cls.contains("chart") && el.querySelector("img")) {
      for (const img of Array.from(el.querySelectorAll("img")))
        picture(img, { alt: (img.getAttribute("alt") ?? "").trim() });
      const caption = el.querySelector("figcaption");
      if (caption)
        out.push({ t: "p", runs: trimRuns(runsOf(caption)), kind: "small" });
      return;
    }
    if (tag === "figure" && cls.contains("chart")) {
      const values = el.getAttribute("data-values");
      const caption = el.querySelector("figcaption");
      // A drawn chart goes in as a picture of itself (showcase u05: a bar
      // chart became a table of raw numbers); its numbers are the fallback.
      if (el.querySelector("svg") && !cls.contains("as-numbers")) {
        let parsed: Array<[string, number]> | undefined;
        try {
          parsed = values
            ? (JSON.parse(values) as Array<[string, number]>)
            : undefined;
        } catch {
          parsed = undefined;
        }
        // The drawing only: its caption follows as text.
        picture(el.querySelector("svg")!, parsed ? { values: parsed } : {});
        if (caption)
          out.push({ t: "p", runs: trimRuns(runsOf(caption)), kind: "small" });
        return;
      }
      if (caption)
        out.push({ t: "p", runs: trimRuns(runsOf(caption)), kind: "small" });
      if (values) {
        const v = JSON.parse(values) as Array<[string, number]>;
        out.push({
          t: "table",
          rows: v.map(([a, b]) => ({
            header: false,
            cells: [[{ text: String(a) }], [{ text: String(b) }]],
          })),
        });
      }
      return;
    }
    if (cls.contains("answer-lines")) {
      const n =
        el.querySelectorAll("i").length ||
        Number(el.getAttribute("data-lines")) ||
        3;
      for (let i = 0; i < n; i++)
        out.push({ t: "p", runs: [{ text: "_".repeat(70) }] });
      return;
    }
    if (cls.contains("field")) {
      out.push({
        t: "p",
        runs: [
          ...trimRuns(runsOf(el)),
          { text: ": ______________________________" },
        ],
      });
      return;
    }
    if (cls.contains("tile")) {
      out.push({
        t: "p",
        runs: trimRuns(runsOf(el).map((r) => ({ ...r, text: r.text + " " }))),
      });
      return;
    }
    if (cls.contains("options")) {
      for (const o of Array.from(el.children))
        out.push({
          t: "li",
          runs: trimRuns(runsOf(o)),
          ordered: false,
          level: 0,
        });
      return;
    }
    if (!hasBlockChild(el)) {
      const runs = trimRuns(runsOf(el));
      if (runs.length > 0)
        out.push({
          t: "p",
          runs,
          ...(cls.contains("kicker")
            ? { kind: "kicker" as const }
            : cls.contains("lead")
              ? { kind: "lead" as const }
              : cls.contains("callout")
                ? { kind: "callout" as const }
                : cls.contains("from") && el.closest(".letter") != null
                  ? { kind: "letterhead" as const }
                  : cls.contains("from") || cls.contains("right")
                    ? { kind: "right" as const }
                    : {}),
        });
    } else {
      // Mixed content: block children and loose text beside them, in order.
      el.childNodes.forEach((n) => {
        if (n.nodeType === 1) walk(n as Element);
        else looseText(n);
      });
    }
    if (cls.contains("cover")) out.push({ t: "break" });
  };
  const walkKeeping = (el: Element): void => {
    // A letter's closing stays with the paragraph before it.
    if (el.classList.contains("closing")) {
      const before = out.length;
      walk(el);
      for (let i = Math.max(0, before - 1); i < out.length; i++) {
        const b = out[i]!;
        if (b.t === "p") b.keep = true;
      }
      return;
    }
    if (
      hasBlockChild(el) &&
      !/^(ul|ol|table|figure)$/.test(el.tagName.toLowerCase()) &&
      !el.classList.contains("tile")
    ) {
      el.childNodes.forEach((n) => {
        if (n.nodeType === 1) walkKeeping(n as Element);
        else looseText(n);
      });
      if (el.classList.contains("cover")) out.push({ t: "break" });
      return;
    }
    walk(el);
  };
  for (const c of Array.from(doc.body.children)) walkKeeping(c);
  return out;
}

const runs = (
  rs: Run[],
  extra: { bold?: boolean; size?: number; color?: string } = {}
): TextRun[] =>
  rs.flatMap((r) =>
    r.text.split("\n").map(
      (part, i) =>
        new TextRun({
          text: part,
          break: i > 0 ? 1 : 0,
          bold: r.bold || extra.bold,
          italics: r.italic,
          ...(extra.size ? { size: extra.size } : {}),
          ...(extra.color ? { color: extra.color } : {}),
        })
    )
  );

/** The .docx, in code, from the blocks. */
export const buildDocx = async (blocks: Block[]): Promise<Buffer> => {
  const accent = "0f6e6a";
  const running =
    blocks.find((b): b is Extract<Block, { t: "running" }> => b.t === "running")
      ?.text ?? null;
  const children: Array<Paragraph | Table> = [];
  for (const b of blocks) {
    if (b.t === "h")
      children.push(
        new Paragraph({
          heading: [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
          ][b.level - 1],
          children: runs(b.runs),
        })
      );
    else if (b.t === "p" && b.kind === "letterhead") {
      // The sender as a letterhead: the name large, the address small under
      // it, a rule across (review of 17 Nov: "no letterhead").
      const [name = "", ...rest] = b.runs
        .map((r) => r.text)
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: name, bold: true, size: 36, color: "17191C" }),
            ...rest.map(
              (line) =>
                new TextRun({ text: line, break: 1, size: 18, color: "5B616B" })
            ),
          ],
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 12,
              color: accent,
              space: 8,
            },
          },
          spacing: { after: 480 },
        })
      );
    } else if (b.t === "p")
      children.push(
        new Paragraph({
          children: runs(
            b.runs,
            b.kind === "kicker"
              ? { bold: true, size: 18, color: accent }
              : b.kind === "lead"
                ? { size: 26, color: "5B616B" }
                : b.kind === "small"
                  ? { size: 18, color: "5B616B" }
                  : {}
          ),
          ...(b.kind === "right" ? { alignment: AlignmentType.RIGHT } : {}),
          ...(b.kind === "callout"
            ? {
                shading: {
                  type: ShadingType.CLEAR,
                  fill: "EEF4F4",
                  color: "auto",
                },
                border: {
                  left: {
                    style: BorderStyle.SINGLE,
                    size: 18,
                    color: accent,
                    space: 6,
                  },
                },
              }
            : {}),
          spacing: { after: 160 },
          ...(b.keep ? { keepNext: true, keepLines: true } : {}),
        })
      );
    else if (b.t === "li")
      children.push(
        new Paragraph({
          children: runs(b.runs),
          ...(b.ordered
            ? {
                numbering: {
                  reference: "ordered",
                  level: b.level,
                  // Each list from 1 (showcase u05: the second ran 4-9).
                  ...(b.list != null ? { instance: b.list } : {}),
                },
              }
            : { bullet: { level: b.level } }),
        })
      );
    else if (b.t === "picture") {
      if (b.data != null && b.w != null && b.h != null && b.w > 0) {
        // Px as printed; no wider than the text column (6.5 in at 96 dpi).
        const width = Math.min(624, Math.round(b.w));
        const height = Math.round((b.h * width) / b.w);
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            keepNext: true,
            children: [
              new ImageRun({
                type: "png",
                data: b.data,
                transformation: { width, height },
                ...(b.alt
                  ? {
                      altText: {
                        name: b.alt,
                        description: b.alt,
                        title: b.alt,
                      },
                    }
                  : {}),
              }),
            ],
          })
        );
      } else if (b.values != null && b.values.length > 0) {
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: b.values.map(
              ([a, v]) =>
                new TableRow({
                  children: [String(a), String(v)].map(
                    (text) =>
                      new TableCell({
                        children: [
                          new Paragraph({ children: [new TextRun({ text })] }),
                        ],
                      })
                  ),
                })
            ),
          }),
          new Paragraph({ children: [] })
        );
      }
    } else if (b.t === "break")
      children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
    else if (b.t === "table") {
      const cols = Math.max(...b.rows.map((r) => r.cells.length), 1);
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map(
            (r) =>
              new TableRow({
                tableHeader: r.header,
                children: Array.from(
                  { length: cols },
                  (_, i) =>
                    new TableCell({
                      children: [
                        new Paragraph({
                          children: runs(r.cells[i] ?? [], {
                            bold: r.header || r.total,
                          }),
                        }),
                      ],
                      ...(r.header
                        ? {
                            shading: {
                              type: ShadingType.CLEAR,
                              fill: "E3F1F0",
                              color: "auto",
                            },
                          }
                        : {}),
                    })
                ),
              })
          ),
        }),
        new Paragraph({ children: [] })
      );
    }
  }
  const doc = new DocxDocument({
    styles: {
      // 1.15 line spacing: single-spaced Word text read as cramped (review of 17 Nov).
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { line: 276 } },
        },
      },
      // Heading 1 to 3: size, colour, space before and after.
      paragraphStyles: (
        [
          [36, "17191C", 240, 120],
          [28, accent, 240, 100],
          [23, undefined, 160, 60],
        ] as const
      ).map(([size, color, before, after], i) => ({
        id: `Heading${i + 1}`,
        name: `Heading ${i + 1}`,
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size, bold: true, ...(color ? { color } : {}) },
        paragraph: { keepNext: true, spacing: { before, after } },
      })),
    },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: "decimal" as never,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
          })),
        },
      ],
    },
    sections: [
      {
        properties: {},
        // A header asked for ("the society name in the header"): the page's
        // running line, on every page (bug hunt f17: Word had none).
        ...(running != null
          ? {
              headers: {
                default: new Header({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        new TextRun({
                          text: running,
                          size: 18,
                          color: "5B6068",
                        }),
                      ],
                    }),
                  ],
                }),
              },
            }
          : {}),
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    children: [
                      PageNumber.CURRENT,
                      " / ",
                      PageNumber.TOTAL_PAGES,
                    ],
                    size: 16,
                    color: "8B9099",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
};
