/**
 * `design`: the parent-facing tool for mockups; the work is in design-task.ts.
 */
import { Type } from "typebox";

import { runDesignTask, type DesignTaskContext } from "./design-task.js";
import type { AgentEvent } from "./protocol.js";
import { resolveInWorkspace } from "./workspace-path.js";

export function designToolEnabled(): boolean {
  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes("design");
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

export function buildDesignTool(
  context: DesignTaskContext,
  emit: (event: AgentEvent) => void
): PiToolDefinitionLike {
  let counter = 0;

  return {
    name: "design",
    label: "design",
    description: [
      "Design the screens of a product: a canvas of mockups, plus a PNG of each screen.",
      "",
      "Hand over the brief and an output directory; a sub-agent picks the palette, composes",
      "each screen from a block catalog, writes every word on them, and renders the canvas.",
      "It reads the workspace first if the brief points at it, so real field names and real",
      "statuses beat invented ones.",
      "",
      "The look is not yours to specify and not the sub-agent's to write: layout, spacing,",
      "type and shadows belong to the blocks. Ask for what the product does and what belongs",
      "on each screen, not for a visual style.",
      "",
      "Hand the result over with present_deliverable.",
    ].join("\n"),
    parameters: Type.Object({
      brief: Type.String({
        description:
          "What the product is, who uses it, and what belongs on each screen, as if to someone who has not read this conversation.",
      }),
      output_dir: Type.String({
        description:
          "Directory for the canvas and screens. Relative paths resolve against the workspace.",
      }),
      screens: Type.Optional(
        Type.Number({
          description: "Roughly how many screens. Defaults to four.",
        })
      ),
      fidelity: Type.Optional(
        Type.Union([Type.Literal("high"), Type.Literal("wire")], {
          description:
            '"high" is a finished-looking mockup; "wire" is a greyscale wireframe. Defaults to high.',
        })
      ),
      device: Type.Optional(
        Type.Union(
          [
            Type.Literal("desktop"),
            Type.Literal("phone"),
            Type.Literal("both"),
          ],
          {
            description: "Defaults to desktop.",
          }
        )
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
      const requestedDir =
        typeof params.output_dir === "string" ? params.output_dir.trim() : "";
      // Resolved here, where the workspace is known; see workspace-path.ts.
      const outputDir =
        requestedDir.length > 0
          ? resolveInWorkspace(requestedDir, context.cwd)
          : "";

      if (brief.length === 0) {
        return {
          content: [{ type: "text" as const, text: "A brief is required." }],
          details: {},
          isError: true,
        };
      }

      if (outputDir.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "An output_dir is required." },
          ],
          details: {},
          isError: true,
        };
      }

      const wanted =
        typeof params.screens === "number" && params.screens > 0
          ? params.screens
          : 4;
      const subtaskId = `design-${Date.now()}-${++counter}`;
      emit({
        type: "subtask_start",
        id: subtaskId,
        description: brief.length > 120 ? `${brief.slice(0, 117)}…` : brief,
        kind: "delegate",
      });

      let result;
      let status: "completed" | "failed" = "failed";
      try {
        result = await runDesignTask(
          context,
          `${brief}\n\nDesign about ${wanted} screens.`,
          outputDir,
          {
            ...(typeof params.fidelity === "string"
              ? { fidelity: params.fidelity }
              : {}),
            ...(typeof params.device === "string"
              ? { device: params.device }
              : {}),
          },
          emit,
          signal
        );
        // A stopped run is not a finished one, however much was drawn.
        status =
          result.canvasPath != null && result.stoppedBy !== "aborted"
            ? "completed"
            : "failed";

        if (result.text.trim().length > 0)
          emit({ type: "text_delta", content: result.text });
      } finally {
        emit({ type: "subtask_end", id: subtaskId, status });
      }

      if (result.canvasPath == null || result.stoppedBy === "aborted") {
        return {
          content: [
            {
              type: "text" as const,
              text: (result.stoppedBy === "aborted"
                ? `The design was stopped before it was finished. ${result.text}`
                : `Nothing was designed. ${result.text}`
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
              `Designed ${result.screens ?? 0} screens: ${result.canvasPath}`,
              `Screens and PNGs: ${result.directory ?? outputDir}`,
              "",
              `Hand it over: present_deliverable with ${result.canvasPath}`,
            ].join("\n"),
          },
        ],
        details: {
          turns: result.turns,
          stoppedBy: result.stoppedBy,
          canvasPath: result.canvasPath,
        },
      };
    },
  };
}
