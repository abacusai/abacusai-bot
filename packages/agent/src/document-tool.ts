/**
 * `document`: the parent-facing tool for "write me a document". The run is a
 * sub-agent so the parent's transcript carries a path, not the prose; bracketed
 * like `delegate_task` for its own card. The work is in document-task.ts.
 */
import { Type } from "typebox";

import { briefLanguageProblem } from "./brief-language.js";
import { runDocsSystemTool, turnOf } from "./docs-system-task.js";
import {
  LOOKS,
  namedLook,
  runDocumentTask,
  type DocumentContext,
} from "./document-task.js";
import { scopeEmit, tagEvent } from "./event-meta.js";
import { modelPath } from "./model-path.js";
import type { AgentEvent } from "./protocol.js";
import { withSourceFile } from "./source-file.js";
import { resolveInWorkspace } from "./workspace-path.js";

/** Off with its toolset, like every other tool the panel can withhold. */
/** Turns whose brief was sent back for its language (once a turn). */
const languageSent = new Set<string>();

export function documentToolEnabled(): boolean {
  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes("document");
}

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

export function buildDocumentTool(
  context: DocumentContext,
  emit: (event: AgentEvent) => void
): PiToolDefinitionLike {
  let counter = 0;

  return {
    name: "document",
    label: "document",
    description: docsSystemEnabled()
      ? DOCS_SYSTEM_DESCRIPTION
      : [
          "Write a document and print it as a PDF.",
          "",
          "Hand over the brief and the output path; a sub-agent plans the document, writes each",
          'section, and prints it. It reads files if the brief points at them, so "write up how',
          'the session service works, from src/main" produces a document about the code rather',
          "than about your description of it.",
          "",
          "The page layout is not negotiable and not yours to specify: the paper size, margins,",
          "stylesheet and cover are fixed, which is what makes the output look the same every",
          "time. Ask for content, not formatting.",
          "",
          "It also draws designed forms, with any sums worked out for it: an invoice, a quote or",
          "estimate, a proposal, a worksheet or study guide, an activity report, a certificate, a",
          "resume/CV or a letter. Say which one in the first sentence of the brief and give the",
          "facts. Do not build these yourself in HTML or with a script.",
          "",
          "If the user names a look (ledger, signal, press, slate or atlas), pass it as template.",
          "",
          "For an existing PDF (reading it, merging, splitting, watermarking, filling a form, or",
          "reprinting one of these documents after editing its HTML source), use `pdf`.",
          "",
          "Hand the result over with present_deliverable.",
        ].join("\n"),
    parameters: Type.Object({
      brief: Type.String({
        description:
          "Everything the document should cover, as if to someone who has not read this conversation. Name files to read if the content is in the workspace.",
      }),
      source_file: Type.Optional(
        Type.String({
          description:
            "The user's own .pptx or .docx when they want it improved or redesigned. The tool reads its words, chart data and pictures itself: do not read, unzip or render the file yourself.",
        })
      ),
      output_path: Type.String({
        description:
          "Where to write the PDF. Relative paths resolve against the workspace.",
      }),
      // Word from the design system; a named look prints on the templates.
      ...(docsSystemEnabled()
        ? {
            word: Type.Optional(
              Type.Boolean({
                description:
                  "True when the user wants a Word file (.docx) as well as, or instead of, the PDF.",
              })
            ),
          }
        : {}),
      template: Type.Optional(
        Type.String({
          description:
            "A look the user asked for by name: ledger, signal, press, slate or atlas. Leave it out unless they named one.",
        })
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      // Stop can land before the tool starts; a sub-session would outlive the
      // turn.
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Stopped." }],
          details: { stoppedBy: "aborted" },
          isError: true,
        };
      }

      const given = typeof params.brief === "string" ? params.brief.trim() : "";
      const requestedPath =
        typeof params.output_path === "string" ? params.output_path.trim() : "";
      // Resolved here: the host's cwd is `/` in a packaged app.
      const outputPath =
        requestedPath.length > 0
          ? resolveInWorkspace(requestedPath, context.cwd)
          : "";

      // The file's language follows the user's own words, asked once a turn.
      const languageTurn = turnOf(context);
      const wrongLanguage = languageSent.has(languageTurn ?? "")
        ? null
        : briefLanguageProblem(
            (context.requestSources?.().user ?? []).slice(-1).join("\n"),
            given
          );
      if (wrongLanguage != null) {
        languageSent.add(languageTurn ?? "");
        return {
          content: [{ type: "text" as const, text: wrongLanguage }],
          details: {},
          isError: true,
        };
      }

      if (given.length === 0) {
        return {
          content: [{ type: "text" as const, text: "A brief is required." }],
          details: {},
          isError: true,
        };
      }

      if (outputPath.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "An output_path is required." },
          ],
          details: {},
          isError: true,
        };
      }

      let brief: string;
      try {
        brief = await withSourceFile(
          given,
          params.source_file,
          outputPath,
          context.cwd
        );
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const subtaskId = `document-${Date.now()}-${++counter}`;
      emit(
        tagEvent(
          {
            type: "subtask_start",
            id: subtaskId,
            description: brief.length > 120 ? `${brief.slice(0, 117)}…` : brief,
            kind: "delegate",
          },
          { parentToolCallId: toolCallId }
        )
      );
      // Everything the sub-agent does is tagged as its own (AG-UI only).
      const childEmit = scopeEmit(emit, subtaskId);

      // A look the user picked by name (the templates gallery) is printed in
      // that look; anything else goes through the design system.
      // Only a look the user named: the bot passed "slate" on its own for a
      // CV and sent it down the old forms path (17 Nov rerun).
      const asked =
        typeof params.template === "string"
          ? params.template.trim().toLowerCase()
          : "";
      const userWords = (context.requestSources?.().user ?? []).join("\n");
      const look =
        LOOKS.includes(asked) &&
        new RegExp(`\\b${asked}\\b`, "i").test(userWords)
          ? asked
          : namedLook(userWords || brief);

      // The design system: printed and checked in code (docs-system-task.ts).
      if (docsSystemEnabled() && look == null)
        return await runDocsSystemTool(
          context,
          {
            brief,
            outputPath,
            kind: "doc",
            word: params.word === true || /\.docx$/i.test(outputPath),
          },
          { emit, childEmit, subtaskId, signal }
        );

      let result;
      let status: "completed" | "failed" = "failed";
      try {
        result = await runDocumentTask(
          context,
          brief,
          outputPath,
          childEmit,
          signal,
          look ?? undefined
        );
        // Printing is the deliverable, whether or not the run ran out of turns.
        // Stop is the exception: whatever was printed is a fragment.
        status =
          result.pdfPath != null && result.stoppedBy !== "aborted"
            ? "completed"
            : "failed";

        if (result.text.trim().length > 0)
          childEmit({ type: "text_delta", content: result.text });
      } finally {
        emit({ type: "subtask_end", id: subtaskId, status });
      }

      if (result.pdfPath == null || result.stoppedBy === "aborted") {
        return {
          content: [
            {
              type: "text" as const,
              text: (result.stoppedBy === "aborted"
                ? `The document was stopped before it was finished. ${result.text}`
                : `No document was printed. ${result.text}`
              ).trim(),
            },
          ],
          details: { turns: result.turns, stoppedBy: result.stoppedBy },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: documentResultText({
              pdfPath: result.pdfPath,
              ...(result.htmlPath != null ? { htmlPath: result.htmlPath } : {}),
              ...(result.pages != null ? { pages: result.pages } : {}),
            }),
          },
        ],
        details: {
          turns: result.turns,
          stoppedBy: result.stoppedBy,
          pdfPath: result.pdfPath,
        },
      };
    },
  };
}

/**
 * What the bot is told once its document is printed. A change goes back
 * through document, which redoes the sums and the checks; "edit that file and
 * reprint it" once cost a bot 50 tool calls.
 */
export const documentResultText = (result: {
  pdfPath: string;
  htmlPath?: string;
  pages?: number;
}): string =>
  [
    `Wrote ${result.pages ?? "?"} pages: ${modelPath(result.pdfPath)}`,
    ...(result.htmlPath != null
      ? [`HTML source: ${modelPath(result.htmlPath)}`]
      : []),
    "",
    `Hand it over: present_deliverable with ${modelPath(result.pdfPath)}`,
    "",
    'To change it, call document again with the brief and the change written into it ("add a cover", "the total should include delivery"); it is printed again and checked.',
  ].join("\n");

/** The design-system pipeline (experiment); off with ABACUSAI_BOT_DOCS_SYSTEM=0. */
export function docsSystemEnabled(): boolean {
  return process.env.ABACUSAI_BOT_DOCS_SYSTEM !== "0";
}

/** What the bot is told about `document` while the design system is on. */
const DOCS_SYSTEM_DESCRIPTION = [
  "Make any document and print it: a report, notes, a quiz or worksheet, a quote or invoice, a",
  "letter, minutes, a resume, a notice, a flyer or poster, a certificate. In any language; it",
  "ships the fonts (Bengali, Devanagari and Latin scripts included).",
  "",
  "Hand over the brief with every fact, figure, name and date the user gave (and the paths of",
  "any pictures or logo to use), and the output path. The app does the sums, charts and page",
  "fitting, and checks the print. Details the user did not give (their name, college, the",
  "client) go in the brief as blanks like [Your name]: they print as fill-in lines. Never",
  "invent a person. With no length asked, keep a report to about 6 pages. For Word, set word: true (or give an output_path ending in",
  ".docx).",
  "",
  "Use this instead of writing HTML, a docx script or a PDF yourself. To change something it",
  "made, call it again with the same output_path and the change; it edits the kept source.",
].join("\n");
