/**
 * Designing a set of screens, as a sub-agent of this process. The model never
 * writes markup: it picks a palette and blocks and writes every word, and the
 * renderer owns the markup. `design_catalog` strips each block's `html` so the
 * sub-agent cannot be talked into adjusting what it cannot see.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { confinedBashTool } from "./backends.js";
import { excludedTools } from "./excluded-tools.js";
import guardrails from "./extensions/guardrails.js";
import type { HostServiceClient } from "./host-services.js";
import type { AgentEvent } from "./protocol.js";
import { whenAborted } from "./subagent-abort.js";
import { forwardChildToolEvents, traceChildEvent } from "./subagent-events.js";

const MAX_PROVIDER_RETRIES = 2;

/**
 * A backstop on a run nobody is watching: the tool-timeouts watchdog can report
 * an overrun but cannot end a call, so a model looping on a tool would spend
 * the parent's whole budget. The wall clock matches that watchdog's 900s.
 */
const MAX_TURNS = 100;
const TIMEOUT_MS = 15 * 60 * 1000;

/** The markup is the harness's, so `write`/`edit` would only produce files nothing serves. */
const EXCLUDED_TOOLS = [
  "write",
  "edit",
  "delegate_task",
  "todo",
  "browser_task",
  "document",
];

const SYSTEM_PROMPT = [
  "You design the screens of a product and then stop. You write no markup.",
  "",
  "The order of work:",
  "  1. If the brief points at the workspace, read it first — real field names and real",
  "     statuses beat invented ones.",
  "  2. `design_catalog` — the blocks you can compose screens from, and the slots each",
  "     one takes. Call this before planning; you cannot guess the vocabulary.",
  "  3. `render_design` with the plan. It writes the canvas, each screen, and a PNG per",
  "     frame, and returns the paths.",
  "",
  "The plan shape:",
  "  name      the product name",
  "  palette   {accent, ink, paper, surface} as hex",
  '  font      "system" | "serif" | "mono"',
  '  screens   each with id (lowercase-slug), title, frame ("desktop" | "phone"), and',
  '            blocks: [{component: "<catalog name>", slots: {…}}]',
  "",
  "Composing a screen:",
  "  - Use only components that appear in the catalog, and only the slots that component",
  "    declares. A component you invent is dropped from the render, silently, and the",
  "    screen comes out missing a piece.",
  "  - Fill slots with the product's real words. Labels, headings, table rows, empty-state",
  "    copy. This is the part of the mockup a reader actually judges.",
  "  - One nav per screen, and one primary action. Two of either reads as a mistake.",
  "",
  "You do not choose the layout, the spacing, the type or the shadows — the blocks own",
  "those. Asking for a different look means choosing different blocks, not describing one.",
  "",
  "Two ways this goes wrong, both of which waste the whole run:",
  "  - Do NOT render trial screens to see what a block does. The catalog describes every",
  "    block and its slots; that description is what you plan from. render_design writes the",
  "    real deliverable to the real path, so a probe render IS the output, and the user gets",
  "    your experiment instead of their design. Call it once, with the actual plan.",
  "  - Do NOT open the PNGs. You almost certainly cannot see images, and each attempt costs",
  "    a turn and tells you nothing. You do not need to: render_design reports which screens",
  "    came out empty and lists any block it dropped. That report is the check.",
  "",
  "Explore the workspace only if the brief points at it. Otherwise go straight from the",
  "catalog to the plan — a design brief does not need investigating.",
  "",
  "Your final message says what you designed and where it is, in two sentences.",
].join("\n");

export interface DesignTaskContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  hostServices: HostServiceClient;
  skillPaths: string[];
  model?: unknown;
}

export interface DesignTaskResult {
  text: string;
  turns: number;
  stoppedBy:
    | "completed"
    | "error"
    | "provider-error"
    | "turn-limit"
    | "timeout"
    | "aborted";
  canvasPath?: string;
  directory?: string;
  screens?: number;
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

const buildTools = (
  done: {
    current: { canvasPath: string; directory: string; screens: number } | null;
  },
  outputDir: string,
  fidelity: string,
  device: string,
  hostServices: HostServiceClient
): PiToolDefinitionLike[] => [
  {
    name: "design_catalog",
    label: "design_catalog",
    description:
      "The blocks a screen can be composed from: each one's name, category, which frames " +
      "it suits, what it is for, and the slots it takes. Call before planning.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const catalog = (await hostServices.request("design_catalog", {})) as {
          components?: Array<Record<string, unknown>>;
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(catalog.components ?? [], null, 1),
            },
          ],
          details: { components: (catalog.components ?? []).length },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `The catalog could not be read: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  },
  {
    name: "render_design",
    label: "render_design",
    description:
      "Compose the screens from catalog blocks, write the canvas and export a PNG per " +
      "frame. Call once, with the whole plan.",
    parameters: Type.Object({
      plan: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        description:
          "The design plan: name, palette, font, screens (each with blocks and slots).",
      }),
    }),
    execute: async (_id, params) => {
      if (params.plan == null || typeof params.plan !== "object") {
        return {
          content: [
            { type: "text" as const, text: "A plan object is required." },
          ],
          details: {},
          isError: true,
        };
      }

      try {
        const result = (await hostServices.request("render_design", {
          plan: params.plan,
          outputDir,
          fidelity,
          device,
        })) as {
          canvasPath?: string;
          directory?: string;
          screens?: Array<{ id: string; png: string }>;
          warnings?: string[];
        };

        if (typeof result?.canvasPath !== "string") {
          return {
            content: [
              {
                type: "text" as const,
                text: "The host rendered nothing and gave no canvas path.",
              },
            ],
            details: {},
            isError: true,
          };
        }

        done.current = {
          canvasPath: result.canvasPath,
          directory: result.directory ?? outputDir,
          screens: (result.screens ?? []).length,
        };

        const missing = (result.screens ?? [])
          .filter((screen) => screen.png === "")
          .map((screen) => screen.id);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Rendered ${(result.screens ?? []).length} screens: ${result.canvasPath}`,
                ...(missing.length > 0
                  ? [
                      `No PNG for: ${missing.join(", ")} — those screens came out empty.`,
                    ]
                  : []),
                ...(result.warnings != null && result.warnings.length > 0
                  ? result.warnings
                  : []),
                "You are done — say what you designed.",
              ].join("\n"),
            },
          ],
          details: { canvasPath: result.canvasPath },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `The design could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  },
];

const extractText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) =>
      typeof block === "object" && block != null && "text" in block
        ? String((block as { text: unknown }).text ?? "")
        : ""
    )
    .join("");
};

export async function runDesignTask(
  context: DesignTaskContext,
  brief: string,
  outputDir: string,
  options: { fidelity?: string; device?: string },
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<DesignTaskResult> {
  const forwardTools = forwardChildToolEvents("des", emit);
  const done: {
    current: { canvasPath: string; directory: string; screens: number } | null;
  } = {
    current: null,
  };
  let turns = 0;
  let lastText = "";
  let retries = 0;
  let providerError = "";
  const outcome: { stoppedBy: DesignTaskResult["stoppedBy"] } = {
    stoppedBy: "completed",
  };

  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd,
      agentDir: context.agentDir,
      settingsManager: context.settingsManager,
      additionalSkillPaths: context.skillPaths,
      appendSystemPrompt: [SYSTEM_PROMPT],
      extensionFactories: [
        {
          name: "abacusai-bot-guardrails",
          factory: guardrails as unknown as (pi: ExtensionAPI) => void,
        },
      ] satisfies InlineExtension[],
    });

    await resourceLoader.reload();

    // The SAME confined shell as the main session; pi's built-in bash is
    // neither
    // sandboxed nor gated, so a sub-agent would walk around the sandbox.
    const confinedBash = confinedBashTool(context.cwd);

    const created = await createAgentSession({
      cwd: context.cwd,
      agentDir: context.agentDir,
      modelRuntime: context.modelRuntime,
      resourceLoader,
      settingsManager: context.settingsManager,
      customTools: [
        ...(confinedBash != null ? [confinedBash] : []),
        ...buildTools(
          done,
          outputDir,
          options.fidelity ?? "high",
          options.device ?? "desktop",
          context.hostServices
        ),
      ] as never,
      // Capabilities choices apply here too, or the shell comes back off-
      // switch.
      excludeTools: [
        ...EXCLUDED_TOOLS,
        ...excludedTools(),
        ...(confinedBash != null ? ["bash"] : []),
      ],
      ...(context.model != null ? { model: context.model as never } : {}),
    });

    const session = created.session;

    try {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          traceChildEvent("des", event);

          if (forwardTools(event)) return;

          // `message_end`, not `message_update`: a provider call that fails
          // outright never produces an update, the failure is stamped on the
          // assistant message itself.
          if (event.type === "message_end") {
            const message = (
              event as {
                message?: { stopReason?: unknown; errorMessage?: unknown };
              }
            ).message;

            if (
              message?.stopReason === "error" &&
              typeof message.errorMessage === "string"
            ) {
              providerError = message.errorMessage;
            }
          }

          // `turn_end` is the per-model-call event. `agent_end` fires once per
          // prompt however many tools run, so a ceiling there could never trip.
          if (event.type === "turn_end") {
            turns += 1;

            if (turns >= MAX_TURNS) {
              outcome.stoppedBy = "turn-limit";
              unsubscribe();
              resolve();

              return;
            }
          }

          if (event.type === "agent_end") {
            if ((event as { willRetry?: boolean }).willRetry === true) {
              retries += 1;

              if (retries > MAX_PROVIDER_RETRIES) {
                outcome.stoppedBy = "provider-error";
                unsubscribe();
                resolve();
              }

              return;
            }

            const messages =
              (
                event as {
                  messages?: Array<{ role?: string; content?: unknown }>;
                }
              ).messages ?? [];

            for (const message of messages) {
              if (message.role !== "assistant") continue;

              const text = extractText(message.content);

              if (text.trim().length > 0) lastText = text;
            }

            if (done.current != null) {
              outcome.stoppedBy = "completed";
              unsubscribe();
              resolve();
              return;
            }
          }

          if (event.type === "agent_settled") {
            unsubscribe();
            resolve();
          }
        });
      });

      void session.prompt(brief).catch((error: unknown) => {
        outcome.stoppedBy = "error";
        providerError = error instanceof Error ? error.message : String(error);
        finish();
      });

      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutTimer = setTimeout(() => {
          outcome.stoppedBy = "timeout";
          resolve();
        }, TIMEOUT_MS);
      });

      // Removed in the finally: the signal outlives this call.
      const abort = whenAborted(signal, () => {
        outcome.stoppedBy = "aborted";
      });

      try {
        // Stop arrives via the abort signal and ends the run like the timeout
        // does.
        await Promise.race([finished, timeout, abort.aborted]);
      } finally {
        if (timeoutTimer != null) clearTimeout(timeoutTimer);
        abort.dispose();
      }
    } finally {
      // A capped run can be mid-tool; a stranded child leaves the card
      // spinning.
      forwardTools.settle();
      session.abort();
    }
  } catch (error) {
    return {
      text: `The design sub-agent could not start: ${error instanceof Error ? error.message : String(error)}`,
      turns,
      stoppedBy: "error",
    };
  }

  return {
    text:
      lastText.trim().length > 0
        ? lastText
        : providerError.length > 0
          ? `The design sub-agent stopped: ${providerError}`
          : "The design sub-agent returned nothing.",
    turns,
    stoppedBy: outcome.stoppedBy,
    ...(done.current != null
      ? {
          canvasPath: done.current.canvasPath,
          directory: done.current.directory,
          screens: done.current.screens,
        }
      : {}),
  };
}
