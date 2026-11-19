/**
 * `ppt`: the parent-facing tool for "make me a deck"; work is in deck-task.ts.
 */
import fs from "node:fs/promises";

import { Type } from "typebox";

import {
  namedTemplate,
  runDeckTask,
  type DeckTaskContext,
} from "./deck-task.js";
import {
  markPassed,
  passedThisTurn,
  runDocsSystemTool,
  sourceFor,
  turnOf,
} from "./docs-system-task.js";
import { docsSystemEnabled } from "./document-tool.js";
import { scopeEmit, tagEvent } from "./event-meta.js";
import { modelPath } from "./model-path.js";
import type { AgentEvent } from "./protocol.js";
import { withSourceFile } from "./source-file.js";
import { resolveInWorkspace } from "./workspace-path.js";

export function deckToolEnabled(): boolean {
  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes("ppt");
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

/** Whether the design system made the deck at this path (its kept source). */
const madeByDesignSystem = (outputPath: string): Promise<boolean> =>
  fs
    .stat(sourceFor(outputPath))
    .then(() => true)
    .catch(() => false);

/** A listed template the call or the brief names, or undefined. */
const chosenTemplate = async (
  context: DeckTaskContext,
  brief: string,
  asked: unknown
): Promise<string | undefined> => {
  const slugs = await context.hostServices
    .request("deck_templates", {})
    .then((result) =>
      ((result as { templates?: Array<{ slug?: unknown }> }).templates ?? [])
        .map((entry) => String(entry.slug ?? ""))
        .filter((slug) => slug.length > 0)
    )
    .catch(() => [] as string[]);
  const slug = typeof asked === "string" ? asked.trim().toLowerCase() : "";
  if (slugs.includes(slug)) return slug;
  return namedTemplate(brief, slugs) ?? undefined;
};

export function buildDeckTool(
  context: DeckTaskContext,
  emit: (event: AgentEvent) => void
): PiToolDefinitionLike {
  let counter = 0;

  return {
    name: "ppt",
    label: "ppt",
    description: docsSystemEnabled()
      ? [
          "Make a slide deck: a PowerPoint (.pptx, editable) and a PDF of the same slides.",
          "",
          "Hand over the brief with every fact, figure, name and date the user gave (and the paths of",
          "any pictures to use), and the output path. The app does the numbers, charts and fitting. If",
          'the user gave an outline ("Slide 1: …, Slide 2: …"), copy it into the brief and pass its',
          "count as slides.",
          "",
          "It prints in one of the app's 37 designed templates: the one the user names (from the",
          "templates gallery; pass its slug as template), or else the one whose slides fit the content.",
          "A name that is not a template slug (a document design such as Heritage, or one that does not",
          "exist): put it in the brief and call this at once; it picks the closest template and says",
          "which. Never search the computer for template names or files, and never build slides",
          "yourself. A template's colours are its own: to change a deck's colour (\"make it green\"),",
          "call this without template and with the colour in the brief; it picks a template in that",
          "colour and keeps the content. For a .pptx or .docx the user wants",
          "improved, pass it as source_file.",
          "",
          "Use this instead of building slides yourself. To change something it made, call it again",
          'with the same output_path and the change ("slide 3\'s title is …"); it edits the kept',
          "source.",
        ].join("\n")
      : [
          "Build a presentation: a designed PDF, plus an editable .pptx of the same deck.",
          "",
          "Hand over the brief and the output path; a sub-agent picks a designed template from a",
          "private catalogue, writes the words of every slide, and prints it. It reads files if",
          "the brief points at them.",
          "",
          "You supply the content, not the design. The template owns the layout, the type and the",
          "palette, and the sub-agent fills text into fixed slots, which is what stops a deck",
          "coming out as a wall of bullet points. Do not ask for a visual style; ask for a subject",
          "and an audience, and say if it is a pitch, a lecture, a review or an announcement,",
          "because that is what picks the template.",
          "",
          "Two files come back: the PDF, and an editable PowerPoint (.pptx) laid out like the PDF,",
          "with the same words in text boxes where the PDF put them, in the same colours and",
          "matching fonts. Some decoration is simpler in the .pptx (shadows, rounded corners,",
          "drawings). Hand over the format the user asked for first: PowerPoint, PPT or slides they",
          "will edit get the .pptx; a PDF to send or print gets the PDF.",
          "",
          "Hand the result over with present_deliverable.",
        ].join("\n"),
    parameters: Type.Object({
      brief: Type.String({
        description:
          "Everything the deck should say, and who it is for, as if to someone who has not read this conversation.",
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
      slides: Type.Optional(
        Type.Number({
          description: docsSystemEnabled()
            ? "Target slide count."
            : "Target slide count. Defaults to five.",
        })
      ),
      template: Type.Optional(
        Type.String({
          description:
            "A template slug the user asked for by name (from the templates gallery, or to keep a deck's design when changing it, but not for a colour change). Leave it out otherwise.",
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
              // A damaged file: the bot told the user "7.96 bits/byte entropy"
              // after running seven commands on it (bug hunt, row 20).
              text: `The file looks damaged and could not be opened (${error instanceof Error ? error.message.slice(0, 80) : "unreadable"}). Tell the user in plain words: "The file looks damaged; please attach it again." Do not examine the file yourself.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const asked =
        typeof params.slides === "number" && params.slides > 0
          ? params.slides
          : undefined;
      const wanted = asked ?? 5;
      const subtaskId = `deck-${Date.now()}-${++counter}`;
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

      // ABACUSAI_BOT_DECK_TEMPLATES=0 keeps decks on the design system unless
      // a template is named (to compare the two).
      // Decks print in a designed template by default: the one the user named
      // (the templates gallery), or the one whose slides fit the content
      // (review of 17 Nov: the plain decks all looked alike). The design
      // system makes the user's own deck anew (source_file), keeps changing a
      // deck it made, and is the fallback when a template deck fails.
      const template = docsSystemEnabled()
        ? await chosenTemplate(context, brief, params.template)
        : typeof params.template === "string"
          ? params.template
          : undefined;
      const plain = (): ReturnType<typeof runDocsSystemTool> =>
        runDocsSystemTool(
          context,
          { brief, outputPath, kind: "deck", slides: asked },
          { emit, childEmit, subtaskId, signal }
        );
      if (
        docsSystemEnabled() &&
        template == null &&
        (process.env.ABACUSAI_BOT_DECK_TEMPLATES === "0" ||
          typeof params.source_file === "string" ||
          // The user's pictures are placed by the design system; template
          // slides hold no photos.
          /\.(png|jpe?g|webp|gif)\b/i.test(brief) ||
          (await madeByDesignSystem(outputPath)))
      )
        return await plain();

      // A template deck that printed is done for this turn, as on the design
      // system: no polishing passes (deck-speed.md).
      const turn = turnOf(context);
      if (passedThisTurn(turn, "deck"))
        return {
          content: [
            {
              type: "text" as const,
              text: "This deck already printed in this turn: it is done. Hand it over with present_deliverable now. Call ppt again only when the user asks for a change.",
            },
          ],
          details: { stoppedBy: "passed" },
          isError: true,
        };

      let result;
      let status: "completed" | "failed" = "failed";
      try {
        result = await runDeckTask(
          context,
          brief,
          outputPath,
          wanted,
          childEmit,
          signal,
          template
        );
        // A stopped run is not a finished one, however much was printed.
        status =
          result.pdfPath != null && result.stoppedBy !== "aborted"
            ? "completed"
            : "failed";

        if (result.text.trim().length > 0)
          childEmit({ type: "text_delta", content: result.text });
      } finally {
        emit({ type: "subtask_end", id: subtaskId, status });
      }

      // A template deck that could not be printed is made on the design
      // system instead, rather than handed back empty.
      if (
        result.pdfPath == null &&
        result.stoppedBy !== "aborted" &&
        docsSystemEnabled() &&
        !signal?.aborted
      ) {
        emit(
          tagEvent(
            {
              type: "subtask_start",
              id: subtaskId,
              description:
                brief.length > 120 ? `${brief.slice(0, 117)}…` : brief,
              kind: "delegate",
            },
            { parentToolCallId: toolCallId }
          )
        );
        return await plain();
      }

      if (result.pdfPath == null || result.stoppedBy === "aborted") {
        return {
          content: [
            {
              type: "text" as const,
              text: (result.stoppedBy === "aborted"
                ? `The deck was stopped before it was finished. ${result.text}`
                : `No deck was printed. ${result.text}`
              ).trim(),
            },
          ],
          details: { turns: result.turns, stoppedBy: result.stoppedBy },
          isError: true,
        };
      }

      markPassed(turn, "deck");
      return {
        content: [
          {
            type: "text" as const,
            text: deckResultText(
              { ...result, pdfPath: result.pdfPath },
              wanted
            ),
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

/** What the bot is told once its deck is printed. */
export const deckResultText = (
  result: {
    pdfPath: string;
    pptxPath?: string | null;
    htmlPath?: string;
    slides?: number;
    template?: string;
    splitNote?: string;
    printNotes?: string[];
  },
  wanted: number
): string =>
  [
    `Built a ${result.slides ?? wanted}-slide deck on template "${result.template ?? "unknown"}": ${modelPath(result.pdfPath)}`,
    ...(result.pptxPath != null
      ? [
          `Editable PowerPoint: ${modelPath(result.pptxPath)} (laid out like the PDF)`,
        ]
      : ["No .pptx could be written; the PDF is the only output."]),
    ...(result.htmlPath != null && result.htmlPath.length > 0
      ? [`HTML source: ${modelPath(result.htmlPath)}`]
      : []),
    "",
    // .pptx first: the preview pane opens the first item and renders
    // pptx natively, so the editable deck is what the user sees.
    result.pptxPath != null
      ? `Hand BOTH over with present_deliverable, in this order: ${modelPath(result.pptxPath)} (label "Editable deck"), then ${modelPath(result.pdfPath)} (label "Designed PDF").`
      : `Hand it over: present_deliverable with ${modelPath(result.pdfPath)}`,
    ...(result.splitNote != null
      ? ["", `${result.splitNote} Say so to the user in one line.`]
      : []),
    ...((result.printNotes ?? []).length > 0
      ? ["", ...result.printNotes!, "Tell the user these in plain words."]
      : []),
    ...(result.slides != null && result.slides < wanted
      ? [
          "",
          // emerald-editorial offers six slides; asked for seven, the bot
          // built the seventh by hand and the .pptx kept six. A slide the
          // print left out is the reason when there is one: the bot once
          // blamed the template's size for it.
          (result.printNotes ?? []).some((note) => note.startsWith("Left out"))
            ? `It printed ${result.slides} of the ${wanted} slides asked for because of the slide left out above, not the template's size. Tell the user, and offer to put that content on another slide; do not build slides by hand.`
            : `It printed ${result.slides} of the ${wanted} slides asked for: that is all this template could fill from the brief. Tell the user, and offer another template or fewer slides; do not build slides by hand.`,
        ]
      : []),
    "",
    // Users change a deck over many rounds: ppt again prints both files and
    // runs every check, which a hand edit of the HTML skips.
    `To change it, call ppt again${result.template != null ? ` with template "${result.template}" (so the deck keeps its design),` : " with"} the brief and the change written into it ("slide 3's title should say…", "add a pricing slide"); both files are printed again and checked. A hand edit of the HTML skips those checks and can leave the .pptx behind the PDF.`,
  ].join("\n");
