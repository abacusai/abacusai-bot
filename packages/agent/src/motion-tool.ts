/**
 * `motion`: the parent-facing tool for short motion graphics videos; the work
 * is in motion-task.ts, the rendering on the desktop (render_motion).
 */
import { Type } from "typebox";

import { scopeEmit, tagEvent } from "./event-meta.js";
import { modelPath } from "./model-path.js";
import { runMotionTask, type MotionTaskContext } from "./motion-task.js";
import type { AgentEvent } from "./protocol.js";
import { resolveInWorkspace } from "./workspace-path.js";

export function motionToolEnabled(): boolean {
  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes("motion");
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

export function buildMotionTool(
  context: MotionTaskContext,
  emit: (event: AgentEvent) => void
): PiToolDefinitionLike {
  let counter = 0;

  return {
    name: "motion",
    label: "motion",
    description: [
      "Make a short motion graphics video (MP4, up to 30 s; 16:9, 9:16 or 1:1) on this",
      "computer, at no cost: a title card or intro, kinetic text for a Reel, an animated bar",
      "chart, a product promo, an explainer, a logo reveal, big headline numbers. One ask is one",
      "video: a longer ask gets the 30 s version, never clips to join. Not footage: no people,",
      "places or photos brought to life.",
      "",
      "Hand over the brief (every word and number on screen, the size, who it is for, an",
      "attached logo's file path, and for a revision the earlier brief with the change) and an",
      "output directory. Hand the result over with present_deliverable.",
    ].join("\n"),
    parameters: Type.Object({
      brief: Type.String({
        description:
          "What the video shows, every word and number it needs, the size, the audience and where it plays, as if to someone who has not read this conversation.",
      }),
      output_dir: Type.String({
        description:
          "Directory for the video. Relative paths resolve against the workspace.",
      }),
    }),
    execute: async (toolCallId, params, signal) => {
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

      const subtaskId = `motion-${Date.now()}-${++counter}`;
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
      const childEmit = scopeEmit(emit, subtaskId);

      let result;
      let status: "completed" | "failed" = "failed";
      try {
        result = await runMotionTask(
          context,
          brief,
          outputDir,
          childEmit,
          signal
        );
        status =
          result.render != null && result.stoppedBy !== "aborted"
            ? "completed"
            : "failed";

        if (result.text.trim().length > 0)
          childEmit({ type: "text_delta", content: result.text });
      } finally {
        emit({ type: "subtask_end", id: subtaskId, status });
      }

      if (result.render == null || result.stoppedBy === "aborted") {
        const text =
          result.stoppedBy === "aborted"
            ? `The video was stopped before it was finished. ${result.text}`
            : result.failed != null
              ? `No video was made. ${result.failed}\nDo not call motion again for this; tell the user it could not be made on this computer.`
              : `No video was made. ${result.text}`;
        return {
          content: [{ type: "text" as const, text: text.trim() }],
          details: { turns: result.turns, stoppedBy: result.stoppedBy },
          isError: true,
        };
      }

      const { render } = result;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Made a ${render.seconds} s ${render.size} video (${render.template}): ${modelPath(render.videoPath)}`,
              // What the sub-agent said: what is on screen, and whether it is
              // shorter than asked (30 s is the most).
              result.text.trim(),
              "",
              `Hand it over: present_deliverable with ${modelPath(render.videoPath)}`,
            ].join("\n"),
          },
        ],
        details: {
          turns: result.turns,
          stoppedBy: result.stoppedBy,
          videoPath: render.videoPath,
        },
      };
    },
  };
}
