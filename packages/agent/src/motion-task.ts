/**
 * Making a motion graphics video, as a sub-agent of this process. The model
 * never writes markup or CSS: it picks a template and a frame size and fills
 * the template's slots with words and numbers; the desktop validates the plan,
 * fills the template and renders it frame by frame to an MP4
 * (apps/desktop motion-plan.ts, motion-agent.ts). `motion_templates` carries
 * no markup, so the sub-agent cannot be talked into adjusting what it cannot see.
 */
import {
  createAgentSession,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { confinedBashTool } from "./backends.js";
import { subAgentBasePrompt } from "./base-prompt.js";
import { excludedTools } from "./excluded-tools.js";
import { createGuardrails } from "./extensions/guardrails.js";
import type { HostServiceClient } from "./host-services.js";
import { subAgentMemory } from "./memory/chat.js";
import { modelPath, MODEL_PATH_RESOURCES } from "./model-path.js";
import type { AgentEvent } from "./protocol.js";
import { createResourceLoader } from "./resource-loader.js";
import { forwardChildToolEvents } from "./subagent-events.js";
import {
  makerVoice,
  runSubagent,
  type SubagentRunResult,
  type SubagentStop,
} from "./subagent-run.js";

/** As design-task.ts: a backstop matching the tool-timeouts watchdog. */
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A render is frame by frame on the user's machine: a 30 s 16:9 video took
 * about 75 s on a 4-core VM, and a slow laptop may take twice that.
 */
export const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

/** The markup is the host's, so `write`/`edit` would only produce files nothing renders. */
const EXCLUDED_TOOLS = [
  "write",
  "edit",
  "delegate_task",
  "todo",
  "browser_task",
  "document",
  "design",
  "ppt",
  "motion",
];

const SYSTEM_PROMPT = [
  "You make one short motion graphics video and then stop. You write no markup, CSS or code.",
  "",
  "1. If the brief points at the workspace (a report, numbers in a file), read it first.",
  "2. `motion_templates`: the templates, their slots and limits, and the sizes.",
  "3. `render_motion` with the plan: {template, size, slots, palette?, font?, pace?, seconds?, name}.",
  '   size: "16:9" (YouTube, slides), "9:16" (Reels, Shorts, TikTok, Stories), "1:1" (a feed',
  "   post); as the brief says, else 16:9. palette {accent, ink, paper} (#rrggbb; ink is the",
  '   text, paper the background) only for colours the user named. font "system" | "serif" |',
  '   "mono". pace "slow" | "normal" | "fast" only when the user asked for slower or faster.',
  '   seconds: a length the user named, up to 30 (30 for "a minute" or more). name: a short',
  "   file name.",
  "",
  "The words:",
  "- In the language of the brief, each line short enough to read in a second or two.",
  "- No facts of your own (names, numbers, years, counts): a line the brief does not give only",
  "  restates what it does.",
  "- Words the user gave (a quote, a slogan, their lines) go on screen word for word, each",
  "  once: no hook, closing line or slogan of your own. A quote's author is its closing line.",
  "- Longer than 30 s asked: one video of up to 30 s with all the content, fewer words per",
  "  point, never just a title; say that 30 s is the most.",
  "- A history or a timeline is an explainer, one step per date.",
  "- A revision (faster, another colour, other words) keeps the template, size and words and",
  "  changes only what was asked.",
  "- An attached image (a logo) is a path: put it in logo-reveal's image slot as given.",
  "- render_motion names any slot over its limit: fix exactly that and call it again.",
  "",
  "render_motion is the only way to make the video, and its report is the check: no trial",
  "renders, no opening the MP4, no code, ffmpeg or recording. If no template fits, say so.",
  "",
  "Your final message says what the video shows, its size and length, and where it is, in",
  "two sentences.",
].join("\n");

export interface MotionTaskContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  hostServices: HostServiceClient;
  skillPaths: string[];
  model?: unknown;
}

export interface MotionRender {
  videoPath: string;
  size: string;
  seconds: number;
  template: string;
}

export interface MotionTaskResult {
  text: string;
  turns: number;
  stoppedBy: SubagentStop;
  render?: MotionRender;
  /** The render failure no other plan fixes, when that is how the run ended. */
  failed?: string;
}

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

/**
 * How the desktop ends a render failure that is the machine's, not the plan's
 * (motion-agent.ts RENDER_FAILED): re-planning only repeats it.
 */
const UNFIXABLE = "A different plan will not fix this.";

const failure = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  isError: true,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const buildMotionTools = (
  done: { current: MotionRender | null; failed?: string | null },
  outputDir: string,
  hostServices: HostServiceClient,
  cwd?: string
): PiToolDefinitionLike[] => [
  {
    name: "motion_templates",
    label: "motion_templates",
    description:
      "The motion templates: each one's name, what it is for, and the slots it takes with " +
      "their limits; and the sizes. Call before planning.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const catalog = await hostServices.request("motion_templates", {});
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(catalog, null, 1) },
          ],
          details: {},
        };
      } catch (error) {
        return failure(`The templates could not be read: ${message(error)}`);
      }
    },
  },
  {
    name: "render_motion",
    label: "render_motion",
    description:
      "Render the video from the whole plan; if it names a slot to fix, fix it and call again.",
    parameters: Type.Object({
      plan: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        description:
          "The plan: template, size, slots, and optionally palette, font, pace, seconds, name.",
      }),
    }),
    execute: async (_id, params) => {
      const plan = params.plan;
      if (plan == null || typeof plan !== "object")
        return failure("A plan object is required.");

      try {
        const result = (await hostServices.request(
          "render_motion",
          {
            ...(plan as Record<string, unknown>),
            outputDir,
            ...(cwd != null ? { cwd } : {}),
          },
          RENDER_TIMEOUT_MS
        )) as Partial<MotionRender> & {
          width?: number;
          height?: number;
          warnings?: string[];
        };

        if (typeof result?.videoPath !== "string")
          return failure("The host rendered nothing and gave no video path.");

        done.current = {
          videoPath: result.videoPath,
          size: result.size ?? "",
          seconds: result.seconds ?? 0,
          template: result.template ?? "",
        };

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Rendered ${result.seconds} s at ${result.width}×${result.height} (${result.size}): ${modelPath(result.videoPath)}`,
                ...(result.warnings ?? []),
                "You are done. Say what the video shows.",
              ].join("\n"),
            },
          ],
          details: { videoPath: result.videoPath },
        };
      } catch (error) {
        const text = message(error);
        if (text.includes(UNFIXABLE)) {
          done.failed = text;
          return failure(
            `${text}\nDo not call render_motion again. Stop, and say in one sentence that the video could not be made on this computer.`
          );
        }
        // The host's validation message names the slot to fix; pass it on as is.
        return failure(`The video was not rendered: ${text}`);
      }
    },
  },
];

export async function runMotionTask(
  context: MotionTaskContext,
  brief: string,
  outputDir: string,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<MotionTaskResult> {
  const forwardTools = forwardChildToolEvents("mot", emit);
  const done: { current: MotionRender | null; failed: string | null } = {
    current: null,
    failed: null,
  };
  let run: SubagentRunResult;

  try {
    const resourceLoader = createResourceLoader({
      ...MODEL_PATH_RESOURCES,
      cwd: context.cwd,
      agentDir: context.agentDir,
      settingsManager: context.settingsManager,
      additionalSkillPaths: context.skillPaths,
      systemPromptOverride: () => subAgentBasePrompt(true),
      appendSystemPrompt: [SYSTEM_PROMPT, ...subAgentMemory()],
      extensionFactories: [
        {
          name: "abacusai-bot-guardrails",
          factory: createGuardrails({ confirm: "report" }) as unknown as (
            pi: ExtensionAPI
          ) => void,
        },
      ] satisfies InlineExtension[],
    });

    await resourceLoader.reload();

    // The same confined shell as the main session, for reading the workspace.
    const confinedBash = confinedBashTool(context.cwd);

    const created = await createAgentSession({
      cwd: context.cwd,
      agentDir: context.agentDir,
      modelRuntime: context.modelRuntime,
      resourceLoader,
      settingsManager: context.settingsManager,
      customTools: [
        ...(confinedBash != null ? [confinedBash] : []),
        ...buildMotionTools(done, outputDir, context.hostServices, context.cwd),
      ] as never,
      excludeTools: [
        ...EXCLUDED_TOOLS,
        ...excludedTools(),
        ...(confinedBash != null ? ["bash"] : []),
      ],
      ...(context.model != null ? { model: context.model as never } : {}),
    });

    const session = created.session;

    try {
      run = await runSubagent(session, brief, {
        tag: "mot",
        forwardTools,
        timeoutMs: TIMEOUT_MS,
        ...(signal != null ? { signal } : {}),
        voice: makerVoice("render_motion"),
        isDone: () => done.current != null || done.failed != null,
      });
    } finally {
      forwardTools.settle();
      session.abort();
    }
  } catch (error) {
    return {
      text: `The motion sub-agent could not start: ${message(error)}`,
      turns: 0,
      stoppedBy: "error",
    };
  }

  return {
    text:
      run.text.trim().length > 0
        ? run.text
        : run.providerError.length > 0
          ? `The motion sub-agent stopped: ${run.providerError}`
          : "The motion sub-agent returned nothing.",
    turns: run.turns,
    stoppedBy: run.stoppedBy,
    ...(done.current != null ? { render: done.current } : {}),
    ...(done.current == null && done.failed != null
      ? { failed: done.failed }
      : {}),
  };
}
