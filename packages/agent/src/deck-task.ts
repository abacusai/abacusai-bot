import path from "node:path";

/**
 * Building a deck, as a sub-agent of this process. The desktop extracts each
 * slide's visible text as slots tagged with element and length; the sub-agent
 * answers with replacement strings; the desktop substitutes them. The ~48KB
 * slide markup never crosses the boundary, so it cannot be damaged, and the
 * tags tell a filler whether a string is a heading or a caption.
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
import {
  attachedPaths,
  factsForChecks,
  readAttached,
  type RequestSources,
} from "./request-facts.js";
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
  "  1. If the brief points at the workspace, read it first. Otherwise go straight on:",
  "     a deck brief does not need investigating.",
  "  2. `deck_templates`: the catalogue. Pick the one whose feel matches the brief (a pitch",
  "     is not a lecture, a memorial is not a launch) and whose slides fit its content: list",
  "     what the brief holds (key figures, steps, a comparison or table, a quote, a timeline)",
  "     and pick a template whose best_for names slides for those, so no slide is left empty.",
  "     When several suit, take the first of them in the list.",
  "  3. `deck_slots`: every slide the template has, each with its role and its text slots.",
  "  4. Choose the slides: as many as deck_slots says to pick. Start with the template's first",
  "     slide (the title) and, when its last slide is a closing or thank-you slide, end with it.",
  "     Between them take the slides whose layout your content fills: a slide of four",
  "     figures needs four real figures, a team slide needs names from the brief. Skip the rest.",
  "  5. `render_deck`: the chosen slides' text in one call, which prints the PDF.",
  "",
  "Those four tools are sufficient, and bash is not one of the four. Do not go reading how",
  "they are implemented. A run that spends its calls grepping this repo writes no slides.",
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
  "  - The cover's headline is the deck's subject in the user's own words (\"Climate",
  "    Change\", the startup's name), never a slogan or a phrase of your own. A tagline goes",
  "    in a smaller slot.",
  '  - No slide is a single word. A slot built for a big figure ("20M") takes a figure from',
  "    the brief; with none, do not pick that slide, or write a short phrase of 2 to 5 words.",
  "  - Use ONLY facts from the brief. Invent no statistics, dates, quotes, company names or",
  "    comparisons. A deck that reads well and states things nobody said is worse than a",
  "    thin one. Where a slot has no support in the brief, write something general and true.",
  "",
  "You cannot see the slides and do not need to. render_deck reports the slide count; the",
  "layout is the template's and is not yours to adjust. Do not try to open the PDF.",
  "",
  "Call deck_slots once, for the template you chose. Reading several templates' slots to",
  "compare them spends the run without improving the deck: the catalogue entry is what you",
  "choose on. If a template has fewer slides than asked for, use what it has.",
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
  /** The user's recent messages and what the bot read (request-facts.ts). */
  requestSources?: () => RequestSources;
}

export interface DeckTaskResult {
  text: string;
  turns: number;
  stoppedBy: SubagentStop;
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

/**
 * A template's sample that is a figure ("94%", "2,418", "£8.4M", "#1", "11d"):
 * its slot is drawn huge and narrow, and a word there is clipped at the edge.
 */
const FIGURE = /^[#£$€¥+−-]?\s?\d[\d.,]*\s?(?:%|[a-z×x]{1,3})?$/i;

/**
 * The template a brief names, from the catalogue's slugs: a hyphenated slug
 * anywhere ("emerald-editorial"), or a one-word slug next to the word
 * template or slug ("the grove template", "template with slug grove"), so an
 * ordinary word such as "classroom" is not taken for a choice.
 */
export const namedTemplate = (
  brief: string,
  slugs: readonly string[]
): string | null => {
  const escape = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const slug of [...slugs].sort((a, b) => b.length - a.length)) {
    const name = escape(slug);
    const named = slug.includes("-")
      ? new RegExp(`(^|[^a-z0-9-])${name}([^a-z0-9-]|$)`, "i")
      : new RegExp(
          `\\b(?:template|slug)\\b[\\s:"'“”]*(?:(?:with|called|named)\\s+)?(?:slug\\s+)?["'“]?${name}\\b|\\b${name}["'”]?\\s+template\\b`,
          "i"
        );

    if (named.test(brief)) return slug;
  }

  return null;
};

/** A slot's text that drops the slot instead of filling it. */
const REMOVE = "[remove]";

/** The deck being written, in this process for the length of one run. */
export interface Draft {
  template: string | null;
  /** Who the deck is for, from the user's words (audienceOf). */
  audience?: Audience | null;
  /** The words the audience was read from, for the subject's mood. */
  audienceWords?: string;
  /** The template the user named: deck_slots refuses any other. */
  required?: string | null;
  /** Stand-ins like "[Month, Year]" in the filler's text were listed once. */
  placeholderChecked?: boolean;
  /**
   * Slot ids per slide, in `deck_slots` order: position maps the reply to ids.
   */
  known: Map<number, string[]>;
  /** Each slot's template text, by id per slide: what a kept slot prints. */
  sample: Map<number, string[]>;
  /** Set once the kept sample text was listed back for a check. */
  keptChecked: boolean;
  /**
   * Set once a slide whose strings did not match its slots was sent back:
   * asked once, so a filler that cannot count still gets a deck.
   */
  countChecked?: boolean;
  /** Set once a deck longer than the slide count asked for was sent back. */
  sizeChecked?: boolean;
  /** Set once words sent into a figure's slot were listed back. */
  figureChecked?: boolean;
  /**
   * Set once a deck naming slides not offered, or fewer than asked for, was
   * sent back: printed short, the bot rebuilt the missing slides by hand.
   */
  pickChecked?: boolean;
  /**
   * What the deck's numbers are checked against: the user's words, their
   * files and what the bot read (request-facts.ts), and today's date.
   */
  facts?: string;
  today?: string;
  /** Set once numbers not in the request were sent back; then they are dropped. */
  numbersChecked?: boolean;
  /** Each offered slide's label ("statement and three points"), by index. */
  labels?: Map<number, string>;
  /** How often a slide counting more items than it holds was sent back. */
  itemsChecked?: number;
  /** Set once a printed cover title without the topic was sent back. */
  coverTitleChecked?: boolean;
  /** Set once a cover without the deck's topic was sent back. */
  coverChecked?: boolean;
  /** Set once slides built around figures, with none, were sent back. */
  figurelessChecked?: boolean;
  /** Set once text drawn over other text was sent back. */
  overlapChecked?: boolean;
  printed: {
    pdfPath: string;
    htmlPath: string;
    pptxPath: string | null;
    slides: number;
  } | null;
}

/**
 * Who a deck is for, from the user's own words: a business deck (a pitch,
 * investors, a board), a school deck (a class, children, a lesson), or a
 * casual one (anything else). The user (18 Nov): main's playful Daisy Days
 * deck for "AI for class 10" looked much better than our plain Blue
 * Professional; a deck must never come out plainer than main's.
 */
export type Audience = "business" | "school" | "casual";
export const audienceOf = (words: string): Audience =>
  /\b(pitch|startup|start-up|investors?|board|quarterly|business plan|sales|company|client|b2b|consulting|stakeholders?)\b/i.test(
    words
  )
    ? "business"
    : /\b(class|grade|std|standard|kaksha)\s*\d{1,2}(st|nd|rd|th)?\b|\b(school|schools|kids?|children|pupils|classroom|lesson|vidyalaya|escuela|colegio|niños|bachch?on)\b/i.test(
          words
        )
      ? "school"
      : "casual";

/** A sombre subject: no cheerful children's template (flowers for a war). */
const SERIOUS =
  /\b(war|wars|holocaust|genocide|disaster|tragedy|death|terror\w*|partition|pandemic|famine|slavery|ww\s*[12i]+|world war)\b/i;

/**
 * The catalogue as the filler sees it. A school or casual deck is not offered
 * the quiet, formal templates (calm, restrained, institutional, scholarly);
 * a school deck sees the ones made for lessons first, the most playful of
 * them first, then the other playful ones; a sombre subject loses the
 * cheerful ones. The order turns by the deck's name so decks vary.
 */
export const catalogueFor = (
  list: Array<Record<string, unknown>>,
  audience: Audience | null | undefined,
  seedText: string,
  words = "",
  wanted = 0
): Array<Record<string, unknown>> => {
  // Enough slides for the count asked: a 15-slide ask got a 6-slide
  // template. Where none of the rest has enough, those with the most.
  const enough = (items: Array<Record<string, unknown>>) => {
    const count = (t: Record<string, unknown>): number =>
      typeof t.slide_count === "number" ? t.slide_count : 99;
    const fit = items.filter((t) => count(t) >= wanted);
    if (fit.length > 0 || items.length === 0) return fit;
    const most = Math.max(...items.map(count));
    return items.filter((t) => count(t) === most);
  };
  let seed = 0;
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const turn = <T>(items: T[]): T[] => {
    const at = items.length > 0 ? seed % items.length : 0;
    return [...items.slice(at), ...items.slice(0, at)];
  };
  if (audience == null || audience === "business") return turn(enough(list));
  const text = (t: Record<string, unknown>, ...keys: string[]): string =>
    keys.map((k) => String(t[k] ?? "")).join(" ");
  const serious = SERIOUS.test(words);
  const fits = list.filter(
    (t) =>
      !/\b(restrained|quiet|calm|institutional|professional|scholarly|literary|trustworthy|archival)\b/i.test(
        text(t, "mood")
      ) &&
      !/^high$/i.test(String(t.formality ?? "")) &&
      !(
        serious &&
        /\b(cheerful|sunny|kawaii|whimsical)\b/i.test(text(t, "mood"))
      ) &&
      !(
        audience === "school" &&
        /\b(school|lessons?|children'?s?|student)/i.test(text(t, "avoid_for"))
      )
  );
  if (audience === "casual") return turn(enough(fits));
  const made = fits.filter(
    (t) =>
      /school lesson|children's lesson|school assembly|classroom|explainer/i.test(
        text(t, "occasion")
      ) || /\bfor school\b/i.test(text(t, "best_for"))
  );
  const low = made.filter((t) => /^low$/i.test(String(t.formality ?? "")));
  const rest = made.filter((t) => !low.includes(t));
  const playful = fits.filter(
    (t) =>
      !made.includes(t) &&
      /\b(playful|cheerful|colou?rful|bright|bold|warm)\b/i.test(
        text(t, "mood")
      )
  );
  const ordered = [...turn(low), ...turn(rest), ...turn(playful)];
  return ordered.filter((t) => enough(ordered).includes(t));
};

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];
const asNumber = (word: string): number | null => {
  const n = /^\d{1,2}$/.test(word)
    ? Number(word)
    : NUMBER_WORDS.indexOf(word.toLowerCase());
  return n >= 2 ? n : null;
};

/**
 * How many items a slide holds: from its label ("statement and three points",
 * "four KPI figures") or, failing that, its numbered markers ("01", "02").
 */
export const itemSlots = (label: string, samples: string[]): number | null => {
  // A slide of figures shows numbers, not a counted list.
  if (/\b(figures?|kpis?|stats?|numbers?|metrics?)\b/i.test(label)) return null;
  const named =
    /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})(?:\s+|-)(?:[\w-]+\s+)?(points|items|cards|steps?|columns|figures|findings|rules|reasons|stats|tiles|boxes|panels|rows|people|members|quotes|questions|options|features|services|cases|ideas|lessons|events|sessions)\b/i.exec(
      label
    );
  if (named != null) return asNumber(named[1]!);
  const markers = samples.filter((sample) => /^0\d$/.test(sample)).length;
  return markers >= 2 ? markers : null;
};

const COUNT_WORD =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+(?=(?:[A-Za-z][\w-]*\s+)?[A-Za-z][\w-]*s\b)/i;

/** The count a heading gives its list: "Four Exhibitions", "5 reasons to…". */
export const countIn = (heading: string): number | null => {
  const m =
    /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+(?:[A-Za-z][\w-]*\s+)?[A-Za-z][\w-]*s\b/i.exec(
      heading
    );
  return m == null ? null : asNumber(m[1]!);
};

/** Words that ask for a deck rather than name its topic, in the languages seen. */
const ASK_WORDS = new Set(
  (
    "make create build prepare give do generate design want need please can you me my our your their i a an the of on about for to with and in by " +
    "ppt pptx powerpoint presentation presentations slide slides deck decks pitch short simple nice good " +
    "class grade std standard school students student kids children college level basics basic intro introduction " +
    "it is its that this some one two three four five six seven eight nine ten " +
    "ke ki ka aur par pe ek banao bana do karo mera meri mere ko " +
    "के की का और पर पे एक बनाओ बना दो करो प्रेजेंटेशन प्रस्तुति स्लाइड " +
    "haz hacer una un el la los las sobre de del para presentación presentacion diapositivas"
  ).split(" ")
);

/** A title the user gave word for word ("titled How Small Coastal Towns…"). */
export const titledWords = (request: string): string[] | null => {
  const m = /\btitled\s+["“']?([^"”'\n]{3,160})/i.exec(request);
  if (m == null) return null;
  return m[1]!
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length >= 3);
};

/** The topic's words in the user's own request ("climate change", "water conservation"). */
export const topicWords = (request: string): string[] => {
  // "in the emerald-editorial template" names the look, not the topic.
  // The topic comes before its details ("…arts centre: 4 exhibitions, …").
  const plain = request
    .split(/:\s/)[0]!
    .replace(/\bin the [\w -]{1,40}? (template|design|look)\b/gi, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return [
    ...new Set(
      plain
        .split(/[^\p{L}\p{M}\p{N}]+/u)
        .filter(
          (w) =>
            (w.length >= 3 || /[\u0080-\uffff]/.test(w)) &&
            !ASK_WORDS.has(w) &&
            !(/^\d+$/.test(w) && w.length <= 2)
        )
    ),
  ].slice(0, 8);
};

/**
 * Whether a cover's text names the topic: a short topic (up to three words)
 * needs all of them, a longer one a third. Master's read (18 Nov): e1's cover
 * read "Causes Impacts Solutions", m01's "Ages 12-16 Every Drop Counts".
 */
export const coverNamesTopic = (
  cover: string,
  words: string[],
  exact = false
): boolean => {
  if (words.length === 0) return true;
  const text = cover
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const found = words.filter((w) => text.includes(w)).length;
  if (exact) return found === words.length;
  return words.length <= 3
    ? found === words.length
    : found >= Math.ceil(words.length / 3);
};

export const buildTools = (
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

        // Turned by the deck's name, so the template listed first is not the
        // same every time (five lessons in a row chose one, 17 Nov); a school
        // deck sees only templates made for its audience (catalogueFor).
        const list = result.templates ?? [];
        const turned = catalogueFor(
          list,
          draft.audience ?? audienceOf(draft.audienceWords ?? ""),
          path.basename(outputPath),
          draft.audienceWords ?? "",
          wantedSlides
        );
        return ok(JSON.stringify(turned, null, 1), {
          count: list.length,
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
      "Every slide of the chosen template: each slide's role and its text slots, with the " +
      "element and character budget of each, and how many slides to pick. Call once, " +
      "after choosing a template.",
    parameters: Type.Object({
      template: Type.String({
        description: "The template slug from deck_templates.",
      }),
    }),
    execute: async (_id, params) => {
      const template = String(params.template ?? "").trim();

      if (template.length === 0) return failed("A template slug is required.");
      if (draft.required != null && template !== draft.required)
        return failed(
          `The user asked for the template "${draft.required}". Call deck_slots with template "${draft.required}".`
        );

      try {
        const result = (await hostServices.request("deck_slots", {
          template,
          slides: wantedSlides,
        })) as {
          template?: string;
          available?: number;
          pick?: number;
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
        draft.sample = new Map(
          (result.slides ?? []).map((slide) => [
            slide.index,
            slide.slots.map((slot) => slot.text),
          ])
        );
        draft.labels = new Map(
          (result.slides ?? []).map((slide) => [slide.index, slide.label])
        );

        const offered = (result.slides ?? []).length;
        const pick = Math.min(wantedSlides, offered);
        const note =
          offered <= wantedSlides
            ? `\nThis template has ${offered} slides: use all of them.`
            : pick === 1
              ? `\nPick 1 of these ${offered} slides: the one whose layout holds the content (a statement, points or explainer slide), not the title slide. Render only that one.`
              : `\nPick ${pick} of these ${offered} slides: slide 1 first, the last slide last if it closes the deck, and between them the ones your content fills. Render only those.`;

        // One slide per line: every slide is listed now, and a weak model
        // reads a long indented listing worse than a compact one.
        const listing = (result.slides ?? [])
          .map((slide) => JSON.stringify(slide))
          .join("\n");
        return ok(`${listing}${note}`, {
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
      "Write the slides you chose and print the deck, in one call. Name each by its index " +
      "from deck_slots; only those slides are printed, in the order you list them (the cover stays first and the closing last). For each, give its " +
      "text as an array of strings in the same order deck_slots listed that slide's slots: " +
      "the first string replaces the first slot, and so on. Use an empty string to keep " +
      'the template\'s own text for a slot (right for a label such as "Owner"), and ' +
      `"${REMOVE}" to drop a slot whose sample content does not fit this deck: a card, row ` +
      "or item left with no text is dropped with it.",
    parameters: Type.Object({
      slides: Type.Array(
        Type.Object({
          slide: Type.Number({
            description: "The slide index from deck_slots (1-based).",
          }),
          text: Type.Array(Type.String(), {
            description: `This slide's replacement text, in deck_slots order. Empty string keeps the template's; "${REMOVE}" drops the slot.`,
          }),
        }),
        { description: "The slides you chose, by index." }
      ),
    }),
    execute: async (_id, params) => {
      if (draft.template == null || draft.known.size === 0) {
        return failed("Choose a template and call deck_slots first.");
      }
      if (draft.printed != null)
        return failed(
          `Already printed to ${modelPath(draft.printed.pdfPath)}. Do not render twice.`
        );

      const given = Array.isArray(params.slides) ? params.slides : [];

      if (given.length === 0) return failed("No slides were given.");

      const notes: string[] = [];
      // Slide numbers the template does not offer, which would be skipped.
      const unknown: string[] = [];
      // Strings that do not line up with the slots: the filler skipped or
      // added one, and every slot after it would print its neighbour's text.
      const misaligned: string[] = [];
      // Words where the template draws a figure, e.g. "Again" in a 94% slot.
      const wordsForFigures: string[] = [];
      // Slides built around big figures whose figures all came out empty.
      const figureless: number[] = [];
      // Slides whose heading counts more items than the slide holds.
      const overfull: string[] = [];
      const slides: Array<{ index: number; values: Record<string, string> }> =
        [];
      // Template text a slide keeps, listed back once: a sample figure, name
      // or date kept by default prints as if it were the user's fact.
      const kept: string[] = [];
      // Slots sent no string at all: dropped once the check has run, so the
      // check says so rather than listing them as kept.
      const unsent: string[] = [];
      // The filler's own text with a stand-in in it, listed back once.
      const standins: string[] = [];

      for (const entry of given) {
        const record = (
          typeof entry === "object" && entry != null ? entry : {}
        ) as Record<string, unknown>;
        const index = typeof record.slide === "number" ? record.slide : 0;
        const ids = draft.known.get(index);

        if (ids == null) {
          const line = `No slide ${index}: the slides offered are ${[...draft.known.keys()].join(", ")}.`;
          unknown.push(line);
          notes.push(`${line} Skipped.`);
          continue;
        }

        const text = Array.isArray(record.text)
          ? record.text.map((value) => String(value ?? ""))
          : [];

        // Reported, not refused: the result is still a whole deck, but silence
        // would hide a filler that miscounted and shifted every slot by one.
        if (text.length !== ids.length && draft.countChecked !== true) {
          const samples = draft.sample.get(index) ?? [];
          misaligned.push(
            `Slide ${index}: ${text.length} strings for ${ids.length} slots. Each slot, its template text, and the string that would replace it:`,
            ...ids.map((_, position) => {
              const given = text[position];
              return `  slot ${position + 1} "${samples[position] ?? ""}" <- ${given == null ? "(nothing)" : JSON.stringify(given)}`;
            }),
            ...(text.length > ids.length
              ? [`  (and ${text.length - ids.length} more with no slot)`]
              : [])
          );
        }
        if (text.length !== ids.length) {
          notes.push(
            `Slide ${index}: ${text.length} strings for ${ids.length} slots (${text.length > ids.length ? "extras ignored" : draft.keptChecked ? "the rest are dropped" : "the rest keep the template text"}).`
          );
        }

        const values: Record<string, string> = {};
        const samples = draft.sample.get(index) ?? [];

        ids.forEach((_, position) => {
          const sample = (samples[position] ?? "").trim();
          const given = (text[position] ?? "").trim();
          if (
            FIGURE.test(sample) &&
            // "01", "02": a step's number, which a template may let go.
            !/^0\d$/.test(sample) &&
            given.length > 0 &&
            given !== REMOVE &&
            !/\d/.test(given)
          )
            wordsForFigures.push(
              `slide ${index} slot ${position + 1} holds a figure like "${sample}"; it was sent "${given}"`
            );
        });

        ids.forEach((id, position) => {
          const replacement = text[position];

          if (
            typeof replacement === "string" &&
            replacement.trim().length > 0 &&
            replacement.trim() !== REMOVE &&
            placeholdersIn(replacement).length > 0
          ) {
            // A stand-in never prints: listed once, then taken out.
            if (!draft.placeholderChecked)
              standins.push(
                `slide ${index} slot ${position + 1}: ${JSON.stringify(replacement)}`
              );
            values[id] = withoutPlaceholders(replacement) || REMOVE;
          } else if (
            typeof replacement === "string" &&
            replacement.trim().length > 0
          )
            values[id] = replacement.trim() === REMOVE ? REMOVE : replacement;
          else if (replacement == null && draft.keptChecked)
            // Once the kept text was listed, a slot given no string at all is
            // one the filler ran out before, not one it chose to keep ("").
            values[id] = REMOVE;
          else {
            const sample = draft.sample.get(index)?.[position] ?? "";
            // Template sample text that is a stand-in is never the user's:
            // taken out without asking.
            if (placeholdersIn(sample).length > 0)
              values[id] = withoutPlaceholders(sample) || REMOVE;
            // A connector of the template's own split title ("The STATE of
            // THE WORK AHEAD") kept round the user's words read "The Autumn
            // of Programme": it goes.
            else if (/^(the|of|at|and|in|for|a|an|&)$/i.test(sample.trim()))
              values[id] = REMOVE;
            // A cover's sample text is always the template's own (its title,
            // subtitle, presenter, date): kept, it printed "THE WORK AHEAD"
            // and "A presentation for the leadership team" (live pick).
            else if (index === 1 && sample.length > 0) values[id] = REMOVE;
            else if (sample.length > 0)
              (replacement == null ? unsent : kept).push(
                `slide ${index} slot ${position + 1}: "${sample}"`
              );
          }
        });

        const figureAt = ids
          .map((id, position) => ({
            id,
            sample: (samples[position] ?? "").trim(),
          }))
          .filter(({ sample }) => FIGURE.test(sample) && !/^0\d$/.test(sample));
        if (
          figureAt.length > 0 &&
          figureAt.every(({ id }) => values[id] === REMOVE)
        )
          figureless.push(index);

        // "Four Exhibitions" on a slide of three points printed Exhibition
        // 1-3 (live pick, 18 Nov): a counted list needs the slots to hold it.
        const holds = itemSlots(
          draft.labels?.get(index) ?? "",
          samples.map((sample) => sample.trim())
        );
        if (holds != null) {
          const heading = ids
            .slice(0, 3)
            .map((id) => values[id])
            .filter((v): v is string => typeof v === "string" && v !== REMOVE)
            .join(" ");
          const counted = countIn(heading);
          // Up to twice what it holds: "Twelve talks" over four strands
          // sums the season up rather than listing it.
          if (counted != null && counted > holds && counted <= holds * 2) {
            if (draft.itemsChecked === 2) {
              // Asked twice: the heading stops claiming more than it shows.
              for (const id of ids.slice(0, 3))
                if (typeof values[id] === "string" && values[id] !== REMOVE)
                  values[id] = values[id]!.replace(COUNT_WORD, "")
                    .replace(/^\s+/, "")
                    .replace(/^./, (c) => c.toUpperCase());
            } else {
              const roomy = [...(draft.labels ?? new Map<number, string>())]
                .filter(([, label]) => (itemSlots(label, []) ?? 0) >= counted)
                .map(([at]) => at);
              overfull.push(
                `slide ${index} ("${heading.slice(0, 60)}") counts ${counted} but holds ${holds}${roomy.length > 0 ? `; slide ${roomy.join(" or ")} holds ${counted} or more` : "; no offered slide holds that many, so split the items over two slides"}`
              );
            }
          }
        }

        slides.push({ index, values });
      }

      if (slides.length === 0)
        return failed(`Nothing to render. ${notes.join(" ")}`);

      const offered = [...draft.known.keys()];
      // A slide named twice prints once: block-frame's filler named slide 3
      // three times for a six-slide deck, and four printed.
      const times = new Map<number, number>();
      for (const slide of slides)
        times.set(slide.index, (times.get(slide.index) ?? 0) + 1);
      const repeated = [...times].filter(([, count]) => count > 1);
      const distinct = times.size;
      const short = distinct < wantedSlides && offered.length > distinct;
      if (
        (unknown.length > 0 || repeated.length > 0 || short) &&
        draft.pickChecked !== true
      ) {
        draft.pickChecked = true;
        return failed(
          [
            "Not printed yet.",
            ...unknown,
            ...repeated.map(
              ([index, count]) =>
                `Slide ${index} is named ${count} times; each slide prints once, so give each its own offered slide.`
            ),
            ...(short
              ? [
                  `${distinct} slides given; ${wantedSlides} were asked for. The slides offered are ${offered.join(", ")}.`,
                ]
              : []),
            "",
            "Use only the slides offered, as many as were asked for, so nothing in the brief is left",
            "out; then call render_deck again with every slide. If the brief really fills fewer, send",
            "the same call.",
          ].join("\n")
        );
      }

      if (standins.length > 0 && !draft.placeholderChecked) {
        draft.placeholderChecked = true;
        return failed(
          [
            "Not printed yet: these slots still hold template stand-ins, which would print as written:",
            ...standins.slice(0, 40).map((line) => `  ${line}`),
            "",
            `Replace each with the fact from the brief, or send "${REMOVE}" to drop the slot. Any`,
            "stand-in still there next time is taken out. Then call render_deck again with every slide.",
          ].join("\n")
        );
      }

      if (slides.length > wantedSlides && draft.sizeChecked !== true) {
        draft.sizeChecked = true;
        return failed(
          [
            `Not printed yet: ${slides.length} slides given; ${wantedSlides} were asked for.`,
            `Keep the title, the closing slide if there is one, and the ${wantedSlides} slides in all that`,
            "carry the most of this brief; then call render_deck again with only those.",
          ].join("\n")
        );
      }

      if (
        misaligned.length === 0 &&
        wordsForFigures.length > 0 &&
        draft.figureChecked !== true
      ) {
        draft.figureChecked = true;
        return failed(
          [
            "Not printed yet: these slots are drawn as big figures, and words there are cut off:",
            ...wordsForFigures.map((line) => `  ${line}`),
            "",
            "Put a number from the brief in each (with its unit), move the words to the caption",
            `slot beside it, or send "${REMOVE}" to drop that figure. Then call render_deck again.`,
          ].join("\n")
        );
      }

      // The cover's title is the topic the user asked for; a slogan goes in
      // the subtitle. Sent back once, naming the words.
      const titled = titledWords(draft.audienceWords ?? "");
      const topic = titled ?? topicWords(draft.audienceWords ?? "");
      const cover = slides.reduce<(typeof slides)[number] | undefined>(
        (first, slide) =>
          first == null || slide.index < first.index ? slide : first,
        undefined
      );
      if (
        cover != null &&
        draft.coverChecked !== true &&
        !coverNamesTopic(
          Object.values(cover.values)
            .filter((v) => v !== REMOVE)
            .join(" "),
          topic,
          titled != null
        )
      ) {
        draft.coverChecked = true;
        return failed(
          [
            titled != null
              ? `Not printed yet: the user gave the title word for word; the cover (slide ${cover.index}) must carry all of it (${topic.join(" ")}).`
              : `Not printed yet: the cover (slide ${cover.index}) does not name the topic the user asked for (${topic.join(" ")}).`,
            "Put the topic itself, in the user's words, in the cover's title slots (split over the title lines if the template has two); a tagline or slogan goes in the subtitle slot. Then call render_deck again.",
          ].join("\n")
        );
      }

      if (overfull.length > 0 && (draft.itemsChecked ?? 0) < 2) {
        draft.itemsChecked = (draft.itemsChecked ?? 0) + 1;
        return failed(
          [
            "Not printed yet: these slides count more items than they have room for, so some would be missing:",
            ...overfull.map((line) => `  ${line}`),
            "Use an offered slide with enough item slots, or put the items over two slides (each heading counting its own), then call render_deck again.",
          ].join("\n")
        );
      }

      // A slide drawn around big figures with none left prints as empty boxes
      // with a line each (master's read, e2 slide 2): another slide is asked
      // for once, then the slide is left out.
      if (figureless.length > 0 && draft.figurelessChecked !== true) {
        draft.figurelessChecked = true;
        return failed(
          [
            `Not printed yet: ${figureless.map((i) => `slide ${i}`).join(", ")} ${figureless.length === 1 ? "is" : "are"} drawn around big figures, and none of ${figureless.length === 1 ? "its" : "their"} figures is in the brief, so ${figureless.length === 1 ? "it" : "they"} would print as empty boxes.`,
            "Use another offered slide in its place (or give figures from the brief), then call render_deck again.",
          ].join("\n")
        );
      }
      if (figureless.length > 0 && slides.length > 3)
        for (const index of figureless) {
          const at = slides.findIndex((slide) => slide.index === index);
          if (at > 0) slides.splice(at, 1);
        }

      // Asked once already: keep the count asked for, the opening slides and
      // the last (usually the closing one), rather than print a longer deck.
      if (slides.length > wantedSlides && draft.sizeChecked === true) {
        slides.sort((a, b) => a.index - b.index);
        const last = slides[slides.length - 1]!;
        const dropped = slides.splice(wantedSlides - 1);
        if (wantedSlides > 1) slides.push(last);
        else slides.splice(0, slides.length, slides[0] ?? last);
        notes.push(
          `Kept ${wantedSlides} slides as asked; left out ${dropped
            .filter((slide) => slide !== last)
            .map((slide) => slide.index)
            .join(", ")}.`
        );
      }

      if (misaligned.length > 0) {
        draft.countChecked = true;
        return failed(
          [
            "Not printed yet: these slides' strings do not line up with their slots, so text would",
            "land in the wrong places (a price in a heading, a name in a figure).",
            ...misaligned,
            "",
            'Send exactly one string per slot, in this order: "" keeps the template text,',
            `"${REMOVE}" drops the slot. Then call render_deck again with every slide.`,
          ].join("\n")
        );
      }

      if (kept.length + unsent.length > 0 && !draft.keptChecked) {
        draft.keptChecked = true;
        return failed(
          [
            "Not printed yet.",
            ...(kept.length > 0
              ? [
                  'These slots were sent "", so they keep the template\'s sample text, and it prints exactly as written:',
                  ...kept.slice(0, 40).map((line) => `  ${line}`),
                ]
              : []),
            ...(unsent.length > 0
              ? [
                  'These slots were sent no string, so they are dropped unless you send their text (or "" to keep the sample):',
                  ...unsent.slice(0, 40).map((line) => `  ${line}`),
                ]
              : []),
            "",
            'A label ("Owner", "Status", "Get in touch") is fine to keep. A sample name, figure, date,',
            `email, price or claim is not from this brief: give the real text, or "${REMOVE}" to drop it.`,
            "Then call render_deck again with every slide, one string per slot. If all of the above is",
            "what you want, send the same call.",
          ].join("\n")
        );
      }

      try {
        const result = (await hostServices.request(
          "render_deck",
          {
            template: draft.template,
            outputPath,
            // In the order sent: the filler tells the story (the host keeps the
            // cover first and the closing last).
            slides,
            ...(draft.facts != null
              ? {
                  facts: draft.facts,
                  today: draft.today,
                  dropUnsupported: draft.numbersChecked === true,
                }
              : {}),
          },
          300_000
        )) as {
          pdfPath?: string;
          htmlPath?: string;
          pptxPath?: string | null;
          pptxError?: string | null;
          slides?: number;
          unsupported?: string[];
          overlaps?: string[];
          coverTitle?: string;
          dropped?: string[];
        };

        // A number the request does not give is sent back before printing,
        // once; the next call drops the slot that still carries it (the
        // design system's rule, now on templates too).
        if ((result?.unsupported ?? []).length > 0) {
          draft.numbersChecked = true;
          return failed(
            [
              "Not printed: these numbers are not in the request (the user's words, their files or what you were told):",
              ...result.unsupported!.slice(0, 20).map((line) => `  ${line}`),
              "",
              `Give the figure the brief gives, or "${REMOVE}" to drop the slot. A template's sample figure kept by "" counts too.`,
              "Then call render_deck again with every slide; a slot that still has such a number is dropped.",
            ].join("\n")
          );
        }

        if (typeof result?.pdfPath !== "string")
          return failed("The host printed nothing and gave no path.");

        if (
          (result.overlaps ?? []).length > 0 &&
          draft.overlapChecked !== true
        ) {
          draft.overlapChecked = true;
          return failed(
            [
              "Printed, but text is drawn over other text:",
              ...result.overlaps!.slice(0, 12).map((line) => `  ${line}`),
              "",
              "Shorten those slots (or drop one) so each fits its place, then call render_deck again with every slide.",
            ].join("\n")
          );
        }

        // The cover's title as printed (its largest text) names the topic:
        // m01 printed "Conservation / Every drop counts" with "Water" in a
        // small tag (master, 18 Nov).
        const titledAs = titledWords(draft.audienceWords ?? "");
        const words = titledAs ?? topicWords(draft.audienceWords ?? "");
        if (
          typeof result.coverTitle === "string" &&
          result.coverTitle.length > 0 &&
          draft.coverTitleChecked !== true &&
          !coverNamesTopic(result.coverTitle, words, titledAs != null)
        ) {
          draft.coverTitleChecked = true;
          return failed(
            [
              `Printed, but the cover's title reads "${result.coverTitle.slice(0, 80)}", which is not the topic the user asked for (${words.join(" ")}).`,
              "Put the topic itself, in the user's words, in the cover's title slots (the big ones); a slogan or tagline goes in the subtitle. Then call render_deck again with every slide.",
            ].join("\n")
          );
        }

        draft.printed = {
          pdfPath: result.pdfPath,
          htmlPath: result.htmlPath ?? "",
          pptxPath: result.pptxPath ?? null,
          slides: result.slides ?? slides.length,
        };

        return ok(
          [
            `Printed ${result.slides ?? slides.length} slides to ${modelPath(result.pdfPath)}`,
            ...(result.pptxPath != null
              ? [
                  `Editable PowerPoint: ${modelPath(result.pptxPath)} (laid out like the PDF).`,
                ]
              : [
                  `No editable PowerPoint this time: ${result.pptxError ?? "the export failed"}. The PDF above is unaffected; say so if the user asked for one.`,
                ]),
            ...(result.htmlPath != null
              ? [`HTML source: ${modelPath(result.htmlPath)}`]
              : []),
            ...notes,
            ...((result.dropped ?? []).length > 0
              ? [
                  `Left out because a number in it was not in the request: ${result.dropped!.join("; ")}. Tell the user what was left out.`,
                ]
              : []),
            "You are done. Say what the deck covers.",
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

export async function runDeckTask(
  context: DeckTaskContext,
  brief: string,
  outputPath: string,
  wantedSlides: number,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal,
  requested?: string
): Promise<DeckTaskResult> {
  const forwardTools = forwardChildToolEvents("deck", emit);
  // A template the user named is a rule, not a hint: the filler once chose
  // status-report for a brief that named emerald-editorial.
  // Only to know a template the user named: a host slow to answer must not
  // hold up the deck (a host that never answers held it forever).
  const slugs = await context.hostServices
    .request("deck_templates", {}, 5_000)
    .then((result) =>
      ((result as { templates?: Array<{ slug?: unknown }> }).templates ?? [])
        .map((entry) => String(entry.slug ?? ""))
        .filter((slug) => slug.length > 0)
    )
    .catch(() => [] as string[]);
  const asked = requested?.trim();
  const required =
    asked != null && slugs.includes(asked)
      ? asked
      : namedTemplate(brief, slugs);
  const draft: Draft = {
    template: null,
    known: new Map(),
    sample: new Map(),
    keptChecked: false,
    printed: null,
    required,
    // The user's own words: the bot's brief can say "sales" of a lesson.
    audienceWords:
      context.requestSources?.().user.slice(-2).join("\n") || brief,
  };
  // Numbers are checked against the user and what the bot read, as on the
  // design system (request-facts.ts); without a session there is no check.
  const sources = context.requestSources?.();
  if (sources != null) {
    draft.facts = factsForChecks({
      sources,
      files: await readAttached(attachedPaths(sources.user ?? [])),
      brief,
      original: null,
    });
    draft.today = new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  let run: SubagentRunResult;

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
      const task =
        required != null
          ? `${brief}\n\nThe user asked for the template "${required}": call deck_slots with it; no other template is accepted.`
          : brief;
      run = await runSubagent(session, task, {
        tag: "deck",
        forwardTools,
        timeoutMs: TIMEOUT_MS,
        ...(signal != null ? { signal } : {}),
        // The finished file is the whole job; a model that keeps going tends
        // to render again or start editing.
        voice: makerVoice("render_deck"),
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
      text: `The deck sub-agent could not start: ${error instanceof Error ? error.message : String(error)}`,
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
          ? `The deck sub-agent stopped: ${run.providerError}`
          : "The deck sub-agent returned nothing.",
    turns: run.turns,
    stoppedBy: run.stoppedBy,
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
