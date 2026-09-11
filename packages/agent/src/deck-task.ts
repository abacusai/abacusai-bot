/**
 * Building a deck, as a sub-agent of this process. The desktop extracts each
 * slide's visible text as slots tagged with element and length; the sub-agent
 * answers with replacement strings; the desktop substitutes them. The ~48KB
 * slide markup never crosses the boundary, so it cannot be damaged, and the
 * tags tell a filler whether a string is a heading or a caption.
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

/**
 * `bash` stays available; the prompt, not the toolset, keeps the sub-agent on
 * choose-template, read-slots, write, render rather than grepping this repo.
 */
const EXCLUDED_TOOLS = [
  "write",
  "edit",
  "delegate_task",
  "todo",
  "browser_task",
  "document",
  "design",
];

const SYSTEM_PROMPT = [
  "You write the words of one deck and then stop. You write no markup and choose no layout.",
  "",
  "The order of work:",
  "  1. If the brief points at the workspace, read it first. Otherwise go straight on —",
  "     a deck brief does not need investigating.",
  "  2. `deck_templates` — the catalogue. Pick the one whose feel matches the brief: a",
  "     pitch is not a lecture, a memorial is not a launch.",
  "  3. `deck_slots` — that template's slides, each with its role and its text slots.",
  "  4. `render_deck` — every slide's text in one call, which prints the PDF.",
  "",
  "Those four tools are sufficient, and bash is not one of the four. Do not go reading how",
  "they are implemented — a run that spends its calls grepping this repo writes no slides.",
  "",
  "How the text goes in: for each slide, an array of strings in the same order deck_slots",
  "listed that slide's slots. First string replaces the first slot, second the second. An",
  "empty string keeps the template's own text for that slot. You are not tracking slot ids,",
  "only their order.",
  "",
  "Filling slots:",
  "  - Each slot shows the template's own text, the element it sits in, and its length in",
  "    characters. That length is a budget, not a suggestion: a slide is a fixed box and",
  "    text that grows past it is clipped, not scrolled. Stay close to it. A slot of 9",
  "    characters is a label, not a sentence.",
  "  - The element tells you the register. An <h1> or <h2> is a headline; a <p> is a line",
  "    of prose; a <span> or <div> that holds nine characters is a chip or a stat.",
  "  - Replace every slot that carries the template's example content. Leaving one is",
  "    leaving somebody else's deck in the middle of yours. A slot you skip keeps the",
  "    template's text, which is the right behaviour for a decorative mark and the wrong",
  "    one for a headline.",
  "  - Use ONLY facts from the brief. Invent no statistics, dates, quotes, company names or",
  "    comparisons. A deck that reads well and states things nobody said is worse than a",
  "    thin one. Where a slot has no support in the brief, write something general and true.",
  "",
  "You cannot see the slides and do not need to. render_deck reports the slide count; the",
  "layout is the template's and is not yours to adjust. Do not try to open the PDF.",
  "",
  "Call deck_slots once, for the template you chose. Reading several templates' slots to",
  "compare them spends the run without improving the deck — the catalogue entry is what you",
  "choose on. If a template offers fewer slides than asked for, use what it offers.",
  "",
  "Do not investigate how these tools work. Their descriptions are complete, and the source",
  "of this application is not the subject of your deck even when it happens to be the",
  "directory you are standing in. If a slot looks strange, write for it as given.",
  "",
  "Your final message says what the deck covers and where it is, in two sentences.",
].join("\n");

export interface DeckTaskContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  hostServices: HostServiceClient;
  skillPaths: string[];
  model?: unknown;
}

export interface DeckTaskResult {
  text: string;
  turns: number;
  stoppedBy:
    | "completed"
    | "error"
    | "provider-error"
    | "turn-limit"
    | "timeout"
    | "aborted";
  pdfPath?: string;
  htmlPath?: string;
  pptxPath?: string;
  slides?: number;
  template?: string;
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

const ok = (
  text: string,
  details: unknown = {}
): ReturnType<PiToolDefinitionLike["execute"]> =>
  Promise.resolve({ content: [{ type: "text" as const, text }], details });

const failed = (text: string): ReturnType<PiToolDefinitionLike["execute"]> =>
  Promise.resolve({
    content: [{ type: "text" as const, text }],
    details: {},
    isError: true,
  });

/** The deck being written, in this process for the length of one run. */
interface Draft {
  template: string | null;
  /**
   * Slot ids per slide, in `deck_slots` order: position maps the reply to ids.
   */
  known: Map<number, string[]>;
  printed: {
    pdfPath: string;
    htmlPath: string;
    pptxPath: string | null;
    slides: number;
  } | null;
}

const buildTools = (
  draft: Draft,
  outputPath: string,
  wantedSlides: number,
  hostServices: HostServiceClient
): PiToolDefinitionLike[] => [
  {
    name: "deck_templates",
    label: "deck_templates",
    description:
      "The slide templates you can choose from, with what each one suits. Call first.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const result = (await hostServices.request("deck_templates", {})) as {
          templates?: Array<Record<string, unknown>>;
        };

        return ok(JSON.stringify(result.templates ?? [], null, 1), {
          count: (result.templates ?? []).length,
        });
      } catch (error) {
        return failed(
          `The catalogue could not be read: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
  {
    name: "deck_slots",
    label: "deck_slots",
    description:
      "The chosen template's slides: each slide's role and its text slots, with the " +
      "element and character budget of each. Call once, after choosing a template.",
    parameters: Type.Object({
      template: Type.String({
        description: "The template slug from deck_templates.",
      }),
    }),
    execute: async (_id, params) => {
      const template = String(params.template ?? "").trim();

      if (template.length === 0) return failed("A template slug is required.");

      try {
        const result = (await hostServices.request("deck_slots", {
          template,
          slides: wantedSlides,
        })) as {
          template?: string;
          available?: number;
          slides?: Array<{
            index: number;
            label: string;
            slots: Array<{
              id: string;
              tag: string;
              text: string;
              chars: number;
            }>;
          }>;
        };

        draft.template = result.template ?? template;
        draft.known = new Map(
          (result.slides ?? []).map((slide) => [
            slide.index,
            slide.slots.map((slot) => slot.id),
          ])
        );

        const note =
          (result.available ?? 0) < wantedSlides
            ? `\nThis template offers ${result.available} slides, so the deck has ${result.slides?.length ?? 0}.`
            : "";

        return ok(`${JSON.stringify(result.slides ?? [], null, 1)}${note}`, {
          slides: (result.slides ?? []).length,
        });
      } catch (error) {
        return failed(
          `The slots could not be read: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
  {
    name: "render_deck",
    label: "render_deck",
    description:
      "Write every slide and print the deck, in one call. For each slide, give its text as " +
      "an array of strings in the same order deck_slots listed that slide's slots — the " +
      "first string replaces the first slot, and so on. Use an empty string to keep the " +
      "template's own text for a slot.",
    parameters: Type.Object({
      slides: Type.Array(
        Type.Object({
          slide: Type.Number({
            description: "The slide index from deck_slots (1-based).",
          }),
          text: Type.Array(Type.String(), {
            description:
              "This slide's replacement text, in deck_slots order. Empty string keeps the template's.",
          }),
        }),
        { description: "Every slide, in order." }
      ),
    }),
    execute: async (_id, params) => {
      if (draft.template == null || draft.known.size === 0) {
        return failed("Choose a template and call deck_slots first.");
      }
      if (draft.printed != null)
        return failed(
          `Already printed to ${draft.printed.pdfPath}. Do not render twice.`
        );

      const given = Array.isArray(params.slides) ? params.slides : [];

      if (given.length === 0) return failed("No slides were given.");

      const notes: string[] = [];
      const slides: Array<{ index: number; values: Record<string, string> }> =
        [];

      for (const entry of given) {
        const record = (
          typeof entry === "object" && entry != null ? entry : {}
        ) as Record<string, unknown>;
        const index = typeof record.slide === "number" ? record.slide : 0;
        const ids = draft.known.get(index);

        if (ids == null) {
          notes.push(
            `No slide ${index} — the deck has slides 1 to ${draft.known.size}. Skipped.`
          );
          continue;
        }

        const text = Array.isArray(record.text)
          ? record.text.map((value) => String(value ?? ""))
          : [];

        // Reported, not refused: the result is still a whole deck, but silence
        // would hide a filler that miscounted and shifted every slot by one.
        if (text.length !== ids.length) {
          notes.push(
            `Slide ${index}: ${text.length} strings for ${ids.length} slots — ${text.length > ids.length ? "extras ignored" : "the rest keep the template text"}.`
          );
        }

        const values: Record<string, string> = {};

        ids.forEach((id, position) => {
          const replacement = text[position];

          if (typeof replacement === "string" && replacement.trim().length > 0)
            values[id] = replacement;
        });

        slides.push({ index, values });
      }

      if (slides.length === 0)
        return failed(`Nothing to render. ${notes.join(" ")}`);

      try {
        const result = (await hostServices.request("render_deck", {
          template: draft.template,
          outputPath,
          slides: slides.sort((a, b) => a.index - b.index),
        })) as {
          pdfPath?: string;
          htmlPath?: string;
          pptxPath?: string | null;
          pptxError?: string | null;
          slides?: number;
        };

        if (typeof result?.pdfPath !== "string")
          return failed("The host printed nothing and gave no path.");

        draft.printed = {
          pdfPath: result.pdfPath,
          htmlPath: result.htmlPath ?? "",
          pptxPath: result.pptxPath ?? null,
          slides: result.slides ?? slides.length,
        };

        return ok(
          [
            `Printed ${result.slides ?? slides.length} slides to ${result.pdfPath}`,
            ...(result.pptxPath != null
              ? [
                  `Editable PowerPoint: ${result.pptxPath} — same words, plain layout, not the template's design.`,
                ]
              : [
                  `No editable PowerPoint this time: ${result.pptxError ?? "the export failed"}. The PDF above is unaffected — say so if the user asked for one.`,
                ]),
            ...(result.htmlPath != null
              ? [`HTML source: ${result.htmlPath}`]
              : []),
            ...notes,
            "You are done — say what the deck covers.",
          ].join("\n"),
          { pdfPath: result.pdfPath }
        );
      } catch (error) {
        return failed(
          `The deck could not be printed: ${error instanceof Error ? error.message : String(error)}`
        );
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

export async function runDeckTask(
  context: DeckTaskContext,
  brief: string,
  outputPath: string,
  wantedSlides: number,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<DeckTaskResult> {
  const forwardTools = forwardChildToolEvents("deck", emit);
  const draft: Draft = { template: null, known: new Map(), printed: null };
  let turns = 0;
  let lastText = "";
  let retries = 0;
  let providerError = "";
  const outcome: { stoppedBy: DeckTaskResult["stoppedBy"] } = {
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
        ...buildTools(draft, outputPath, wantedSlides, context.hostServices),
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
          traceChildEvent("deck", event);

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

            if (draft.printed != null) {
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
      text: `The deck sub-agent could not start: ${error instanceof Error ? error.message : String(error)}`,
      turns,
      stoppedBy: "error",
    };
  }

  const printed = draft.printed;

  return {
    text:
      lastText.trim().length > 0
        ? lastText
        : providerError.length > 0
          ? `The deck sub-agent stopped: ${providerError}`
          : "The deck sub-agent returned nothing.",
    turns,
    stoppedBy: outcome.stoppedBy,
    ...(printed != null
      ? {
          pdfPath: printed.pdfPath,
          htmlPath: printed.htmlPath,
          ...(printed.pptxPath != null ? { pptxPath: printed.pptxPath } : {}),
          slides: printed.slides,
          ...(draft.template != null ? { template: draft.template } : {}),
        }
      : {}),
  };
}
