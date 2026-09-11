/**
 * `document` — the parent-facing tool for "write me a document". The run is a
 * sub-agent so the parent's transcript carries a path, not the prose; bracketed
 * like `delegate_task` for its own card. The work is in document-task.ts.
 */
import { Type } from "typebox";

import { runDocumentTask, type DocumentContext } from "./document-task.js";
import type { AgentEvent } from "./protocol.js";
import { resolveInWorkspace } from "./workspace-path.js";

/** Off with its toolset, like every other tool the panel can withhold. */
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
    description: [
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
      "For an existing PDF — reading it, merging, splitting, watermarking, filling a form, or",
      "reprinting one of these documents after editing its HTML source — use `pdf`.",
      "",
      "Hand the result over with present_deliverable.",
    ].join("\n"),
    parameters: Type.Object({
      brief: Type.String({
        description:
          "Everything the document should cover, as if to someone who has not read this conversation. Name files to read if the content is in the workspace.",
      }),
      output_path: Type.String({
        description:
          "Where to write the PDF. Relative paths resolve against the workspace.",
      }),
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

      const subtaskId = `document-${Date.now()}-${++counter}`;
      emit({
        type: "subtask_start",
        id: subtaskId,
        description: brief.length > 120 ? `${brief.slice(0, 117)}…` : brief,
        kind: "delegate",
      });

      let result;
      let status: "completed" | "failed" = "failed";
      try {
        result = await runDocumentTask(
          context,
          brief,
          outputPath,
          emit,
          signal
        );
        // Printing is the deliverable, whether or not the run ran out of turns.
        // Stop is the exception: whatever was printed is a fragment.
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
            text: [
              `Wrote ${result.pages ?? "?"} pages: ${result.pdfPath}`,
              ...(result.htmlPath != null
                ? [
                    `Editable source: ${result.htmlPath}`,
                    'To change what it says, edit that file and reprint it with pdf action "reprint".',
                  ]
                : []),
              "",
              `Hand it over: present_deliverable with ${result.pdfPath}`,
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
