/**
 * Writing a document, as a sub-agent of this process. Only what needs Chromium
 * stays in the desktop: the `render_document` host service takes *sections*,
 * not a page, and owns the shell, stylesheet and paper, so the sub-agent cannot
 * produce a document that fails to lay out. Same limits as `delegation.ts`.
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
import { placeholdersIn, withoutPlaceholders } from "./placeholders.js";
import type { AgentEvent } from "./protocol.js";
import type { RequestSources } from "./request-facts.js";
import { createResourceLoader } from "./resource-loader.js";
import { forwardChildToolEvents } from "./subagent-events.js";
import {
  makerVoice,
  runSubagent,
  type SubagentRunResult,
  type SubagentStop,
} from "./subagent-run.js";

/**
 * A backstop on a run nobody is watching: the tool-timeouts watchdog can report
 * an overrun but cannot end a call, so a model looping on a tool would spend
 * the parent's whole budget. The wall clock matches that watchdog's 900s.
 */
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
const FORM_KINDS = [
  "invoice",
  "quote",
  "resume",
  "letter",
  "certificate",
  "proposal",
  "worksheet",
  "activity_report",
] as const;

/** What each fixed-layout kind takes; the renderer lays it out and does the sums. */
const FORM_FIELDS = [
  "invoice: from_name, from_details (address/email lines), to_name, to_details, number, date,",
  '  due_date, currency (e.g. "$", "€", "INR"), items: [{description, quantity, unit_price}],',
  '  tax_percent, tax_label (e.g. "GST"), discount (an amount), payment_details, notes.',
  '  Write every figure as a plain number (1200.50, not 1.200,50 or "ten").',
  "  Give prices only: subtotal, tax and total are calculated for you.",
  "quote (or estimate): the invoice fields without due_date and payment_details, plus",
  '  heading ("Quote" or "Estimate"), valid_until, terms. Prices only, as for an invoice.',
  "resume: name, headline, contact (lines: email, phone, city, links), summary,",
  "  experience: [{role, organisation, dates, points: [achievements]}],",
  "  education: [{qualification, institution, dates, detail}], skills: [short items].",
  "letter: from_name, from_details, to_name, to_details, date, subject, greeting,",
  "  body (paragraphs), closing, signature_name, signature_title.",
  'certificate: title (e.g. "Certificate of Completion"), recipient_name, statement',
  '  (default "has successfully completed"), achievement (the course or award), detail,',
  "  date, issuer, signatories: [{name, title}] (up to 3), number. One landscape page.",
  "proposal: title, from_name, from_details, to_name, date, number, valid_until, summary,",
  "  problem, approach ([{title, detail}] steps, or paragraphs), deliverables: [short items],",
  "  timeline: [{phase, dates, detail}], currency, items/tax_percent/tax_label/discount as",
  "  for an invoice (prices only; totals are calculated), terms, next_steps: [short items].",
  "worksheet (also a study guide): title, subject, level, instructions, key_points: [short",
  '  items], key_terms: [{term, definition}], questions: [{question, type ("choice",',
  '  "short" or "long"), choices (for choice), marks (a plain number), answer}],',
  "  name_lines (false to leave out name/class/date), show_answers (false for no answer",
  "  key). Questions are numbered and marks added up for you; answers print on their own page.",
  'activity_report: title (e.g. "Monthly activity report"), organisation, period, author,',
  "  date, summary, metrics: [{label, value, previous}] (the change is worked out for you),",
  "  activities: [{date, activity, detail, people, hours}] (totals worked out for you),",
  "  highlights, issues, next_steps: [short items]. Figures as plain numbers (a unit is fine).",
].join("\n");
/** How a brief names each fixed form, matched in its first sentence only. */
const FORM_WORDS: Array<[FormKind, RegExp]> = [
  ["activity_report", /\bactivity reports?\b/i],
  ["worksheet", /\b(work ?sheets?|study guides?|revision sheets?)\b/i],
  ["certificate", /\bcertificates?\b/i],
  ["proposal", /\bproposals?\b/i],
  ["quote", /\b(quotes?|quotations?|estimates?)\b/i],
  ["invoice", /\binvoices?\b/i],
  ["resume", /\b(r[eé]sum[eé]s?|cvs?|curriculum vitae)\b/i],
  ["letter", /\bletters?\b/i],
];

type FormKind = (typeof FORM_KINDS)[number];

/**
 * The fixed form a brief asks for, from its first sentence: "Write and print
 * a British trade quotation..." is a quote; a report that ends with
 * proposals is not a proposal. The earliest match in the sentence wins.
 */
export const formKindOf = (brief: string): FormKind | null => {
  const first = brief
    .trim()
    .split(/(?<=[.!?])\s|\n/)[0]!
    .slice(0, 240);
  let best: { kind: FormKind; at: number } | null = null;
  for (const [kind, words] of FORM_WORDS) {
    const at = first.search(words);
    if (at >= 0 && (best == null || at < best.at)) best = { kind, at };
  }
  return best?.kind ?? null;
};

const formHint = (kind: FormKind): string =>
  `This is ${kind === "activity_report" ? "an activity report" : kind === "invoice" ? "an invoice" : `a ${kind}`}: call fill_form with kind "${kind}" (its fields are listed on the tool) instead of writing sections. Its layout and sums are drawn for you; ignore any layout or styling the brief describes and take only its facts.`;

/** The document looks; the host lists them, this is the fallback. */
export const LOOKS = ["ledger", "signal", "press", "slate", "atlas"];

/**
 * The look a brief names. The looks are ordinary words ("press", "slate"),
 * so a name counts only beside "look", "template" or "style", or
 * capitalised after "in" or "use": "in the Signal look", "Look: Slate",
 * "Print it in Atlas", but not "press coverage" or "a clean slate".
 */
export const namedLook = (
  brief: string,
  looks: readonly string[] = LOOKS
): string | null => {
  const word = "(?:look|template|style|design|theme)";
  for (const look of looks) {
    const title = look[0]!.toUpperCase() + look.slice(1);
    const named = [
      new RegExp(`\\b${look}\\s+${word}\\b`, "i"),
      new RegExp(
        `\\b${word}\\s*[:=]?\\s*(?:called\\s+|named\\s+)?["'“]?${look}\\b`,
        "i"
      ),
      new RegExp(`\\b(?:[Ii]n|[Uu]se|[Uu]sing)\\s+(?:the\\s+)?${title}\\b`),
    ];
    if (named.some((pattern) => pattern.test(brief))) return look;
  }
  return null;
};

/** The brief as the sub-agent reads it: a form is named before anything else. */
export const briefFor = (brief: string, look: string | null = null): string => {
  const kind = formKindOf(brief);
  const lines = [
    ...(kind != null ? [formHint(kind)] : []),
    ...(look != null
      ? [
          `The user asked for the "${look}" look: pass template "${look}" to set_document; no other look is accepted.`,
        ]
      : []),
  ];
  return lines.length === 0 ? brief : `${lines.join("\n")}\n\n${brief}`;
};

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
  "  2. `document_templates`: the looks available, and what each suits. Choose the one that",
  "     fits; never skip this, and never leave the template unset.",
  "  3. `set_document`: the title, a one-sentence standfirst, the shape and that template.",
  "  4. `write_section` once per section, in order. EXCEPT an invoice, a quote or",
  "     estimate, a proposal, a worksheet or study guide, an activity report, a",
  "     resume/CV, a letter or a certificate: these have a fixed, designed layout. Call",
  "     `fill_form` once instead of writing sections, and pick the template for its look.",
  "  5. `render_document`: prints it and returns the path. Call this exactly once,",
  "     when every section is written.",
  "",
  "Style is the document's SHAPE and is separate from the template, which is its LOOK:",
  "  report:    analysis, findings, proposals, anything with structure and tables",
  "  editorial: essays, narrative pieces, long-form argument",
  "  memo:      short internal notes, one or two pages, no cover page",
  "",
  "A report shape in the Press look is a perfectly good document; so is an editorial shape",
  "in Ledger. Pick the shape from what the content is and the template from how it should",
  "feel to the person receiving it.",
  "",
  "Write the document in the language the user wrote in, and pass that language to",
  'set_document (e.g. "tr"): form labels and money then print in it. Dates too: write',
  'them as that language does ("12 Aralık 2026", not "12 December 2026").',
  "",
  "Theme and text size are arguments to set_document, not something to achieve by",
  "editing CSS. A dark theme in particular cannot be done in CSS: the page margins are",
  'painted by the printer, so asking for theme "dark" is the only way to get a dark page',
  "rather than a dark column framed in white.",
  "",
  "Writing the sections:",
  "  - HTML fragments only: <p>, <ul>/<li>, <ol>, <table>, <blockquote>, <h3> for",
  "    sub-headings, <strong>, <em>, <code>. No <html>, <body>, <style>, <script>, no",
  "    class attributes, no inline styles, no <h1> or <h2>. Your heading is printed",
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
  "Your final message is not the document; it has already been printed. Say what you",
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
  /** The user's recent messages and what the bot read (request-facts.ts). */
  requestSources?: () => RequestSources;
}

export interface DocumentResult {
  text: string;
  turns: number;
  stoppedBy: SubagentStop;
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
  form: { kind: string; data: Record<string, unknown> } | null;
  title: string;
  standfirst: string;
  template: string;
  style: DocumentStyle;
  theme: DocumentTheme;
  textSize: DocumentTextSize;
  sections: Array<{ heading: string; html: string }>;
  printed: DocumentResult | null;
  /** The look the user named: set_document refuses any other. */
  required?: string | null;
  /** The document's language code: its form labels, dates and money. */
  language?: string;
}

/** Every string in a form's fields, with the path it sits at. */
const strings = (
  value: unknown,
  at: string
): Array<{ at: string; text: string }> =>
  typeof value === "string"
    ? [{ at, text: value }]
    : Array.isArray(value)
      ? value.flatMap((each, index) => strings(each, `${at}[${index + 1}]`))
      : value != null && typeof value === "object"
        ? Object.entries(value).flatMap(([key, each]) =>
            strings(each, at.length > 0 ? `${at}.${key}` : key)
          )
        : [];

/** The same value with every stand-in taken out of its strings. */
const scrubbed = (value: unknown): unknown =>
  typeof value === "string"
    ? withoutPlaceholders(value)
    : Array.isArray(value)
      ? value.map(scrubbed)
      : value != null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, each]) => [key, scrubbed(each)])
          )
        : value;

/** Stand-ins in what is about to print, each named with where it is. */
const standinsIn = (draft: Draft): string[] => [
  ...(draft.form != null
    ? strings(draft.form.data, "")
        .filter((each) => placeholdersIn(each.text).length > 0)
        .map((each) => `${each.at}: ${JSON.stringify(each.text)}`)
    : []),
  ...draft.sections.flatMap((section) =>
    placeholdersIn(section.html.replace(/<[^>]+>/g, " ")).map(
      (found) => `section "${section.heading}": ${found}`
    )
  ),
];

export const buildDraftTools = (
  draft: Draft,
  outputPath: string,
  hostServices: HostServiceClient,
  /** The fixed form the brief asks for; its first section is refused once. */
  formKind: FormKind | null = null
): PiToolDefinitionLike[] => {
  let pointedAtForm = false;
  let standinsChecked = false;
  return [
    {
      name: "document_templates",
      label: "document_templates",
      description:
        "The looks a document can be printed in: each one's name, what it suits, and its " +
        "mood. Call this before set_document and choose one: there is no undecorated option, " +
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
        standfirst: Type.String({
          description: "One sentence under the title.",
        }),
        style: Type.Union(STYLES.map((style) => Type.Literal(style))),
        template: Type.Optional(
          Type.String({
            description:
              "A slug from document_templates. Required in practice: always choose one.",
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
        language: Type.Optional(
          Type.String({
            description:
              'The language the document is written in, as a code: "en", "tr", "de-DE". Form labels and money print in it; write every field, heading and date in it too.',
          })
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
        if (
          typeof params.language === "string" &&
          params.language.trim().length > 0
        )
          draft.language = params.language.trim();
        draft.standfirst = String(params.standfirst ?? "").slice(0, 400);
        draft.style = (STYLES as readonly string[]).includes(style)
          ? (style as DocumentStyle)
          : "report";
        const template = String(params.template ?? "")
          .trim()
          .toLowerCase();
        if (
          draft.required != null &&
          template.length > 0 &&
          template !== draft.required
        )
          return failed(
            `The user asked for the "${draft.required}" look. Call set_document again with template "${draft.required}".`
          );
        draft.template = template || draft.required || "atlas";
        draft.theme = (THEMES as readonly string[]).includes(theme)
          ? (theme as DocumentTheme)
          : "light";
        draft.textSize = (TEXT_SIZES as readonly string[]).includes(textSize)
          ? (textSize as DocumentTextSize)
          : "normal";

        if (draft.title.length === 0)
          return failed("A document needs a title.");

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
        "in the order they are written. The heading is printed for you; do not repeat it in the body.\n\n" +
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
        if (formKind != null && draft.form == null && !pointedAtForm) {
          pointedAtForm = true;
          return failed(
            `${formHint(formKind)} If this really is not one, write the section again.`
          );
        }

        draft.sections.push({ heading, html });

        return ok(`Section ${draft.sections.length} written: "${heading}".`);
      },
    },
    {
      name: "fill_form",
      label: "fill_form",
      description:
        "For an invoice, a quote/estimate, a proposal, a worksheet/study guide, an activity report, a resume/CV, a letter or a certificate: fill its fields and the renderer lays it " +
        "out (in place of write_section). Call once, after set_document; calling again " +
        "replaces it. Leave out fields you have no facts for; never invent them.\n\n" +
        FORM_FIELDS,
      parameters: Type.Object({
        kind: Type.Union(FORM_KINDS.map((kind) => Type.Literal(kind))),
        data: Type.Record(Type.String(), Type.Unknown(), {
          description: "The fields for that kind, as listed above.",
        }),
      }),
      execute: async (_id, params) => {
        const kind = String(params.kind ?? "");
        if (!(FORM_KINDS as readonly string[]).includes(kind))
          return failed(`kind must be one of: ${FORM_KINDS.join(", ")}.`);
        const data =
          params.data != null && typeof params.data === "object"
            ? (params.data as Record<string, unknown>)
            : {};
        draft.form = { kind, data };
        return ok(
          `The ${kind} is filled (${Object.keys(data).length} fields). Call render_document.`
        );
      },
    },
    {
      name: "render_document",
      label: "render_document",
      description:
        "Print the document and return its path. Call once, when every section is written. " +
        "The page layout, stylesheet and paper size are not yours to choose: this owns them.",
      parameters: Type.Object({}),
      execute: async () => {
        if (draft.title.length === 0) return failed("Call set_document first.");
        if (draft.sections.length === 0 && draft.form == null)
          return failed("Write at least one section (or fill_form) first.");
        if (draft.printed != null) {
          return failed(
            `Already printed to ${modelPath(draft.printed.pdfPath ?? "")}. Do not render twice.`
          );
        }

        // A stand-in such as "[Month, Year]" never prints: listed once, then
        // taken out.
        const standins = standinsIn(draft);
        if (standins.length > 0 && !standinsChecked) {
          standinsChecked = true;
          return failed(
            [
              "Not printed yet: these still hold template stand-ins, which would print as written:",
              ...standins.slice(0, 40).map((line) => `  ${line}`),
              "",
              "Replace each with the fact from the brief, or leave the field out. Any stand-in still",
              "there next time is taken out. Then call render_document again.",
            ].join("\n")
          );
        }
        if (standins.length > 0) {
          if (draft.form != null)
            draft.form = {
              ...draft.form,
              data: scrubbed(draft.form.data) as Record<string, unknown>,
            };
          draft.sections = draft.sections.map((section) => ({
            ...section,
            html: section.html.replace(
              />([^<]*)</g,
              (_all, text: string) =>
                `>${placeholdersIn(text).length > 0 ? withoutPlaceholders(text) : text}<`
            ),
          }));
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
            ...(draft.language != null ? { language: draft.language } : {}),
            sections: draft.form == null ? draft.sections : [],
            ...(draft.form != null ? { form: draft.form } : {}),
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
            ...(typeof result.pages === "number"
              ? { pages: result.pages }
              : {}),
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
              `Printed ${result.pages ?? "?"} pages to ${modelPath(result.pdfPath)}.`,
              `Editable source: ${result.htmlPath == null ? "not reported" : modelPath(result.htmlPath)}.`,
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
              "You are done. Say what you wrote.",
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
  signal?: AbortSignal,
  /** A look the user asked for by name, from the bot's document call. */
  requested?: string
): Promise<DocumentResult> {
  let run: SubagentRunResult;

  // A look the user named is a rule, not a hint: asked for Ledger, the bot
  // briefed the writer without it and the proposal came out in Atlas.
  const asked = requested?.trim().toLowerCase();
  const required =
    asked != null && LOOKS.includes(asked) ? asked : namedLook(brief);

  const draft: Draft = {
    form: null,
    title: "",
    standfirst: "",
    template: "atlas",
    style: "report",
    theme: "light",
    textSize: "normal",
    sections: [],
    printed: null,
    required,
  };
  const forwardTools = forwardChildToolEvents("doc", emit);

  try {
    const resourceLoader = createResourceLoader({
      // Skill and AGENTS.md paths as the model should copy them.
      ...MODEL_PATH_RESOURCES,
      cwd: context.cwd,
      agentDir: context.agentDir,
      settingsManager: context.settingsManager,
      additionalSkillPaths: context.skillPaths,
      // Ours in place of pi's default prompt; see base-prompt.ts.
      systemPromptOverride: () => subAgentBasePrompt(true),
      appendSystemPrompt: [SYSTEM_PROMPT, ...subAgentMemory()],
      // Guardrails only: the permission gate would prompt a user who is not
      // watching, so bash-gate, path-guard and output-trim are the whole
      // policy.
      // Budgets and the verify loop belong to the parent session.
      extensionFactories: [
        {
          name: "abacusai-bot-guardrails",
          // Nobody watches a sub-agent: a judged command runs and is reported.
          factory: createGuardrails({ confirm: "report" }) as unknown as (
            pi: ExtensionAPI
          ) => void,
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
        ...buildDraftTools(
          draft,
          outputPath,
          context.hostServices,
          formKindOf(brief)
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
      run = await runSubagent(session, briefFor(brief, required), {
        tag: "doc",
        forwardTools,
        timeoutMs: TIMEOUT_MS,
        ...(signal != null ? { signal } : {}),
        // The finished file is the whole job; a model that keeps going tends
        // to render again or start editing.
        voice: makerVoice("render_document"),
        isDone: () => draft.printed != null,
      });
    } finally {
      // A capped run can be mid-tool; a stranded child leaves the card
      // spinning.
      forwardTools.settle();
      session.abort();
    }
  } catch (error) {
    return {
      text: `The document sub-agent could not start: ${error instanceof Error ? error.message : String(error)}`,
      turns: 0,
      stoppedBy: "error",
    };
  }

  const printed = draft.printed;

  return {
    text:
      run.text.trim().length > 0
        ? run.text
        : run.providerError.length > 0
          ? `The document sub-agent stopped: ${run.providerError}`
          : "The document sub-agent returned nothing.",
    turns: run.turns,
    stoppedBy: run.stoppedBy,
    ...(printed?.pdfPath != null ? { pdfPath: printed.pdfPath } : {}),
    ...(printed?.pages != null ? { pages: printed.pages } : {}),
    ...(printed?.htmlPath != null ? { htmlPath: printed.htmlPath } : {}),
  };
}
