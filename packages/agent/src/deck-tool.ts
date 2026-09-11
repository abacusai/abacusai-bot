/**
 * `ppt` — the parent-facing tool for "make me a deck"; work is in deck-task.ts.
 */
import { Type } from "typebox";

import { runDeckTask, type DeckTaskContext } from "./deck-task.js";
import type { AgentEvent } from "./protocol.js";
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

export function buildDeckTool(
  context: DeckTaskContext,
  emit: (event: AgentEvent) => void
): PiToolDefinitionLike {
  let counter = 0;

  return {
    name: "ppt",
    label: "ppt",
    description: [
      "Build a presentation: a designed PDF, plus an editable .pptx of the same deck.",
      "",
      "Hand over the brief and the output path; a sub-agent picks a designed template from a",
      "private catalogue, writes the words of every slide, and prints it. It reads files if",
      "the brief points at them.",
      "",
      "You supply the content, not the design. The template owns the layout, the type and the",
      "palette, and the sub-agent fills text into fixed slots — which is what stops a deck",
      "coming out as a wall of bullet points. Do not ask for a visual style; ask for a subject",
      "and an audience, and say if it is a pitch, a lecture, a review or an announcement,",
      "because that is what picks the template.",
      "",
      "Two files come back, and they are not interchangeable. The PDF is pixel-identical to",
      "the chosen template and is what you send or present. The .pptx carries the same words",
      "as real editable text boxes in a plain layout — it is for someone who needs to change",
      "the deck, not for looking at. HTML cannot be converted to PowerPoint, so a file that is",
      "both is not on the table; offer whichever the user actually needs.",
      "",
      "Hand the result over with present_deliverable.",
    ].join("\n"),
    parameters: Type.Object({
      brief: Type.String({
        description:
          "Everything the deck should say, and who it is for — as if to someone who has not read this conversation.",
      }),
      output_path: Type.String({
        description:
          "Where to write the PDF. Relative paths resolve against the workspace.",
      }),
      slides: Type.Optional(
        Type.Number({ description: "Target slide count. Defaults to five." })
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      // Stop can land before the tool starts; a sub-session would outlive the
      // turn.
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Stopped." }],
          details: { stoppedBy: "aborted" },
          isError: true,
        };
      }

      const brief = typeof params.brief === "string" ? params.brief.trim() : "";
      const requestedPath =
        typeof params.output_path === "string" ? params.output_path.trim() : "";
      // Resolved here: the host's cwd is `/` in a packaged app.
      const outputPath =
        requestedPath.length > 0
          ? resolveInWorkspace(requestedPath, context.cwd)
          : "";

      if (brief.length === 0) {
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

      const wanted =
        typeof params.slides === "number" && params.slides > 0
          ? params.slides
          : 5;
      const subtaskId = `deck-${Date.now()}-${++counter}`;
      emit({
        type: "subtask_start",
        id: subtaskId,
        description: brief.length > 120 ? `${brief.slice(0, 117)}…` : brief,
        kind: "delegate",
      });

      let result;
      let status: "completed" | "failed" = "failed";
      try {
        result = await runDeckTask(
          context,
          brief,
          outputPath,
          wanted,
          emit,
          signal
        );
        // A stopped run is not a finished one, however much was printed.
        status =
          result.pdfPath != null && result.stoppedBy !== "aborted"
            ? "completed"
            : "failed";

        if (result.text.trim().length > 0)
          emit({ type: "text_delta", content: result.text });
      } finally {
        emit({ type: "subtask_end", id: subtaskId, status });
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

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Built a ${result.slides ?? wanted}-slide deck on template "${result.template ?? "unknown"}": ${result.pdfPath}`,
              ...(result.pptxPath != null
                ? [
                    `Editable PowerPoint: ${result.pptxPath} (same words, plain layout)`,
                  ]
                : ["No .pptx could be written — the PDF is the only output."]),
              ...(result.htmlPath != null && result.htmlPath.length > 0
                ? [`HTML source: ${result.htmlPath}`]
                : []),
              "",
              // .pptx first: the preview pane opens the first item and renders
              // pptx natively, so the editable deck is what the user sees.
              result.pptxPath != null
                ? `Hand BOTH over with present_deliverable, in this order: ${result.pptxPath} (label "Editable deck"), then ${result.pdfPath} (label "Designed PDF").`
                : `Hand it over: present_deliverable with ${result.pdfPath}`,
            ].join("\n"),
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
