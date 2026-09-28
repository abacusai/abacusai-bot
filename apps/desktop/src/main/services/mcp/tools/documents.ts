import type { ToolDefinition } from "./definition";

/**
 * Document output: PDF work and deck export.
 */
export const DOCUMENTS_TOOLS: ToolDefinition[] = [
  {
    name: "pdf",
    toolsets: ["pdf"],
    description: [
      "Work with a PDF that already exists: read it, or change it.",
      "",
      "To WRITE a new document, use `document` instead: it plans and writes one and prints",
      "it. This tool does not author content.",
      "",
      "Actions:",
      '  "reprint": print a document again from its HTML source (html_path).',
      "             Every document leaves an editable `document.html` beside its PDF. Edit",
      "             that file to change what the document says, then reprint it: the PDF is",
      "             updated in place. This is how you edit a document; the other actions",
      "             move pages around and cannot change a word of the text.",
      '  "read":    text per page (path, optional pages).',
      '  "tables":  tables as rows, per page (path, optional pages).',
      '  "info":    page count, metadata, and whether the text is extractable at all.',
      "             Run this first on a PDF you did not make: a scanned one yields no",
      "             text and needs OCR.",
      '  "merge":   concatenate several PDFs (inputs, output_path).',
      '  "split":   write one PDF per page range (path, output_dir, optional ranges).',
      '  "rotate":  rotate pages (path, output_path, degrees, optional pages).',
      '  "stamp":   draw a watermark across every page (path, output_path, text).',
      '  "forms":   list AcroForm fields (path).',
      '  "fill":    fill form fields (path, output_path, data).',
      "",
      'Pages are 1-based and accept ranges: "1-3,7". Hand a result over with present_deliverable.',
      "Every path here may be relative; it resolves against the workspace directory.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "reprint",
            "read",
            "tables",
            "info",
            "merge",
            "split",
            "rotate",
            "stamp",
            "forms",
            "fill",
          ],
        },
        path: { type: "string", description: "The PDF to read or change." },
        html_path: {
          type: "string",
          description:
            "reprint: the document's HTML source, e.g. report-source/document.html.",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "merge: the PDFs to join, in order.",
        },
        output_path: {
          type: "string",
          description: "Where to write the result.",
        },
        output_dir: {
          type: "string",
          description: "split: the directory for the pieces.",
        },
        pages: {
          type: "string",
          description: 'Page selection, 1-based, e.g. "1-3,7".',
        },
        ranges: {
          type: "string",
          description: 'split: comma-separated ranges, e.g. "1-3,4-9".',
        },
        degrees: { type: "number", description: "rotate: 90, 180 or 270." },
        text: { type: "string", description: "stamp: the watermark text." },
        data: { type: "object", description: "fill: field name to value." },
      },
      required: ["action"],
    },
    run: (host, args) => host.pdf(args),
  },
  {
    name: "deck_export_pdf",
    toolsets: ["ppt"],
    description:
      "Render an HTML slide deck to PDF, one page per slide at the deck's own size. Use after building a deck from the Slide decks skill. Returns the PDF path and the page count.",
    inputSchema: {
      type: "object",
      properties: {
        html_path: {
          type: "string",
          description: "Path to the deck's HTML file.",
        },
        output_path: {
          type: "string",
          description:
            "Where to write the PDF. Defaults to the HTML path with a .pdf suffix.",
        },
        width_px: {
          type: "number",
          description: "Overrides the detected slide width, in CSS pixels.",
        },
        height_px: {
          type: "number",
          description: "Overrides the detected slide height, in CSS pixels.",
        },
      },
      required: ["html_path"],
    },
    run: (host, args) => host.deckExportPdf(args),
  },
];
