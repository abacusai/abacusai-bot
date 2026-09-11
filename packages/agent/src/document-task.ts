/**
 * Writing a document, as a sub-agent of this process. Only what needs Chromium
 * stays in the desktop: the `render_document` host service takes *sections*,
 * not a page, and owns the shell, stylesheet and paper, so the sub-agent cannot
 * produce a document that fails to lay out. Same limits as `delegation.ts`.
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

const MAX_SECTIONS = 15;

/**
 * Tools the sub-agent does not get. No `write`/`edit`: `write_section` is the
 * one way to produce output, so nothing can disagree with the render service.
 * No `bash`: a model that cannot see the PNG measures it in circles, one probe
 * variation after another; the render report says whether the export worked,
 * and what it cannot tell it says in its final message.
 */
const EXCLUDED_TOOLS = [
  "write",
  "edit",
  "delegate_task",
  "todo",
  "browser_task",
];

const STYLES = ["report", "editorial", "memo"] as const;
const THEMES = ["light", "dark"] as const;
const TEXT_SIZES = ["normal", "large"] as const;

type DocumentStyle = (typeof STYLES)[number];
type DocumentTheme = (typeof THEMES)[number];
type DocumentTextSize = (typeof TEXT_SIZES)[number];

const SYSTEM_PROMPT = [
  "You write one document and then stop. Your tools are the only way to produce it:",
  "nothing you say in prose reaches the reader.",
  "",
  "The order of work:",
  "  1. If the brief points at files, read them first. A document about code should be",
  "     about the code, not about the brief.",
  "  2. `document_templates` — the looks available, and what each suits. Choose the one that",
  "     fits; never skip this, and never leave the template unset.",
  "  3. `set_document` — the title, a one-sentence standfirst, the shape and that template.",
  "  4. `write_section` once per section, in order.",
  "  5. `render_document` — prints it and returns the path. Call this exactly once,",
  "     when every section is written.",
  "",
  "Style is the document's SHAPE and is separate from the template, which is its LOOK:",
  "  report    — analysis, findings, proposals, anything with structure and tables",
  "  editorial — essays, narrative pieces, long-form argument",
  "  memo      — short internal notes, one or two pages, no cover page",
  "",
  "A report shape in the Press look is a perfectly good document; so is an editorial shape",
  "in Ledger. Pick the shape from what the content is and the template from how it should",
  "feel to the person receiving it.",
  "",
  "Theme and text size are arguments to set_document, not something to achieve by",
  "editing CSS. A dark theme in particular cannot be done in CSS: the page margins are",
  'painted by the printer, so asking for theme "dark" is the only way to get a dark page',
  "rather than a dark column framed in white.",
  "",
  "Writing the sections:",
  "  - HTML fragments only: <p>, <ul>/<li>, <ol>, <table>, <blockquote>, <h3> for",
  "    sub-headings, <strong>, <em>, <code>. No <html>, <body>, <style>, <script>, no",
  "    class attributes, no inline styles, no <h1> or <h2> — your heading is printed",
  "    for you, so do not repeat it in the body.",
  "  - Use ONLY facts from the brief and from files you have read. Invent no",
  "    statistics, dates, names, quotes or comparisons. Where you lack a specific,",
  "    write the general truth instead.",
  "  - Prose in paragraphs. Reach for a list only when the content is genuinely a",
  "    list, and a table only when it is genuinely tabular.",
  "  - Two to five paragraphs per section. A section is not a chapter.",
  "  - Plan only what the brief supports. A section you cannot fill with real content",
  "    is a section that reads as padding.",
  "  - The layout is not yours. Paper size, margins, the stylesheet and the cover belong to",
  "    the renderer; theme and text size are arguments to set_document. Ask for content.",
  "",
  "Your final message is not the document — it has already been printed. Say what you",
  "wrote and where it is, in two sentences.",
].join("\n");

export interface DocumentContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  hostServices: HostServiceClient;
  skillPaths: string[];
  model?: unknown;
}

export interface DocumentResult {
  text: string;
  turns: number;
  stoppedBy:
    | "completed"
    | "error"
    | "provider-error"
    | "turn-limit"
    | "timeout"
    | "aborted";
  /** Set once `render_document` succeeds; absent means nothing was printed. */
  pdfPath?: string;
  pages?: number;
  htmlPath?: string;
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

/**
 * The document being written, held here for one run so the host service stays
 * stateless and an abandoned run leaves nothing to clean up.
 */
interface Draft {
  title: string;
  standfirst: string;
  template: string;
  style: DocumentStyle;
  theme: DocumentTheme;
  textSize: DocumentTextSize;
  sections: Array<{ heading: string; html: string }>;
  printed: DocumentResult | null;
}

const buildDraftTools = (
  draft: Draft,
  outputPath: string,
  hostServices: HostServiceClient
): PiToolDefinitionLike[] => [
  {
    name: "document_templates",
    label: "document_templates",
    description:
      "The looks a document can be printed in: each one's name, what it suits, and its " +
      "mood. Call this before set_document and choose one — there is no undecorated option, " +
      "because an undecorated document is not a neutral choice but the absence of one.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const result = (await hostServices.request(
          "document_templates",
          {}
        )) as {
          templates?: Array<Record<string, unknown>>;
        };

        return ok(JSON.stringify(result.templates ?? [], null, 1), {
          count: (result.templates ?? []).length,
        });
      } catch (error) {
        return failed(
          `The look-book could not be read: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
  {
    name: "set_document",
    label: "set_document",
    description:
      "The document's title, standfirst, style and appearance. Call once, before writing " +
      "sections; calling again replaces all of it.",
    parameters: Type.Object({
      title: Type.String({ description: "The document title." }),
      standfirst: Type.String({ description: "One sentence under the title." }),
      style: Type.Union(STYLES.map((style) => Type.Literal(style))),
      template: Type.Optional(
        Type.String({
          description:
            "A slug from document_templates. Required in practice — always choose one.",
        })
      ),
      theme: Type.Optional(
        Type.Union(
          THEMES.map((theme) => Type.Literal(theme)),
          {
            description:
              'Page colour. Defaults to light. "dark" prints edge to edge and drops page numbers.',
          }
        )
      ),
      text_size: Type.Optional(
        Type.Union(
          TEXT_SIZES.map((size) => Type.Literal(size)),
          {
            description:
              'Defaults to normal. "large" is for reading on a screen.',
          }
        )
      ),
    }),
    execute: async (_id, params) => {
      const style = String(params.style ?? "");
      const theme = String(params.theme ?? "light");
      const textSize = String(params.text_size ?? "normal");

      draft.title = String(params.title ?? "").slice(0, 160);
      draft.standfirst = String(params.standfirst ?? "").slice(0, 400);
      draft.style = (STYLES as readonly string[]).includes(style)
        ? (style as DocumentStyle)
        : "report";
      draft.template = String(params.template ?? "").trim() || "atlas";
      draft.theme = (THEMES as readonly string[]).includes(theme)
        ? (theme as DocumentTheme)
        : "light";
      draft.textSize = (TEXT_SIZES as readonly string[]).includes(textSize)
        ? (textSize as DocumentTextSize)
        : "normal";

      if (draft.title.length === 0) return failed("A document needs a title.");

      return ok(
        `Set: "${draft.template}" template, ${draft.style} shape, ${draft.theme} theme, ${draft.textSize} text.`
      );
    },
  },
  {
    name: "write_section",
    label: "write_section",
    description:
      "Append one section: its heading, and its body as an HTML fragment. Sections print " +
      "in the order they are written. The heading is printed for you — do not repeat it in the body.\n\n" +
      'Images work: `<img src="https://…">` is fetched and embedded when the document is ' +
      "printed, as is a path to a local file. Use `<figure>` with a `<figcaption>` for a caption. " +
      "An image that cannot be fetched is dropped and reported, so check what render_document says " +
      "before calling the document illustrated.",
    parameters: Type.Object({
      heading: Type.String({ description: "The section heading." }),
      html: Type.String({
        description: "The section body, as an HTML fragment.",
      }),
    }),
    execute: async (_id, params) => {
      if (draft.sections.length >= MAX_SECTIONS) {
        return failed(
          `A document is capped at ${MAX_SECTIONS} sections. Render what you have.`
        );
      }

      const heading = String(params.heading ?? "").trim();
      const html = String(params.html ?? "").trim();

      if (heading.length === 0) return failed("A section needs a heading.");
      if (html.length === 0) return failed("A section needs a body.");

      draft.sections.push({ heading, html });

      return ok(`Section ${draft.sections.length} written: "${heading}".`);
    },
  },
  {
    name: "render_document",
    label: "render_document",
    description:
      "Print the document and return its path. Call once, when every section is written. " +
      "The page layout, stylesheet and paper size are not yours to choose — this owns them.",
    parameters: Type.Object({}),
    execute: async () => {
      if (draft.title.length === 0) return failed("Call set_document first.");
      if (draft.sections.length === 0)
        return failed("Write at least one section first.");
      if (draft.printed != null) {
        return failed(
          `Already printed to ${draft.printed.pdfPath}. Do not render twice.`
        );
      }

      try {
        const result = (await hostServices.request("render_document", {
          outputPath,
          title: draft.title,
          standfirst: draft.standfirst,
          style: draft.style,
          template: draft.template,
          theme: draft.theme,
          textSize: draft.textSize,
          sections: draft.sections,
        })) as {
          pdfPath?: string;
          htmlPath?: string;
          pages?: number;
          previewPath?: string | null;
          images?: number;
          droppedImages?: string[];
        };

        if (typeof result?.pdfPath !== "string") {
          return failed("The host printed nothing and gave no path.");
        }

        draft.printed = {
          text: "",
          turns: 0,
          stoppedBy: "completed",
          pdfPath: result.pdfPath,
          ...(typeof result.pages === "number" ? { pages: result.pages } : {}),
          ...(typeof result.htmlPath === "string"
            ? { htmlPath: result.htmlPath }
            : {}),
        };

        // Images are reported, never assumed.
        const dropped = Array.isArray(result.droppedImages)
          ? result.droppedImages
          : [];

        return ok(
          [
            `Printed ${result.pages ?? "?"} pages to ${result.pdfPath}.`,
            `Editable source: ${result.htmlPath ?? "not reported"}.`,
            ...(typeof result.images === "number" && result.images > 0
              ? [`Images printed: ${result.images}.`]
              : []),
            ...(dropped.length > 0
              ? [
                  `${dropped.length} image${dropped.length === 1 ? "" : "s"} could NOT be printed and ${
                    dropped.length === 1 ? "is" : "are"
                  } missing from the PDF:`,
                  ...dropped.map((line) => `  ${line}`),
                  "Do not describe the document as illustrated unless it has the images you meant.",
                ]
              : []),
            "You are done — say what you wrote.",
          ].join("\n"),
          { pdfPath: result.pdfPath }
        );
      } catch (error) {
        return failed(
          `The document could not be printed: ${error instanceof Error ? error.message : String(error)}`
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

/**
 * Writes one document and returns what happened. Never throws: a failure is
 * reported to the parent as text so it can adapt.
 */
export async function runDocumentTask(
  context: DocumentContext,
  brief: string,
  outputPath: string,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<DocumentResult> {
  let turns = 0;
  let lastText = "";
  let retries = 0;
  let providerError = "";
  const outcome: { stoppedBy: DocumentResult["stoppedBy"] } = {
    stoppedBy: "completed",
  };

  const draft: Draft = {
    title: "",
    standfirst: "",
    template: "atlas",
    style: "report",
    theme: "light",
    textSize: "normal",
    sections: [],
    printed: null,
  };
  const forwardTools = forwardChildToolEvents("doc", emit);

  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd,
      agentDir: context.agentDir,
      settingsManager: context.settingsManager,
      additionalSkillPaths: context.skillPaths,
      appendSystemPrompt: [SYSTEM_PROMPT],
      // Guardrails only: the permission gate would prompt a user who is not
      // watching, so bash-gate, path-guard and output-trim are the whole
      // policy.
      // Budgets and the verify loop belong to the parent session.
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
        ...buildDraftTools(draft, outputPath, context.hostServices),
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
          traceChildEvent("doc", event);

          // The child's tool calls, so its card shows the work (subagent-
          // events.ts).
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

            // A printed document is the whole job; a model that keeps going
            // tends to render again or start editing.
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

      // NOT awaited: `finished` carries the result out when the run ends.
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
      text: `The document sub-agent could not start: ${error instanceof Error ? error.message : String(error)}`,
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
          ? `The document sub-agent stopped: ${providerError}`
          : "The document sub-agent returned nothing.",
    turns,
    stoppedBy: outcome.stoppedBy,
    ...(printed?.pdfPath != null ? { pdfPath: printed.pdfPath } : {}),
    ...(printed?.pages != null ? { pages: printed.pages } : {}),
    ...(printed?.htmlPath != null ? { htmlPath: printed.htmlPath } : {}),
  };
}
