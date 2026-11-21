/**
 * Documents and decks with the design system:
 * the sub-agent writes the whole page as HTML against the app's stylesheet and
 * guide, and one tool, `print`, hands it to the desktop. There code fills the
 * sums, draws the charts, fits the pages, prints the PDF (and the .pptx or
 * .docx), reads it back and says what is wrong. The sub-agent may fix that and
 * print once more; the second print is the last.
 *
 * A change to something already made starts from its source: the current HTML
 * is given to the sub-agent with the change, so the rest is kept.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { subAgentBasePrompt } from "./base-prompt.js";
import { excludedTools } from "./excluded-tools.js";
import { createGuardrails } from "./extensions/guardrails.js";
import type { HostServiceClient } from "./host-services.js";
import { modelPath, MODEL_PATH_RESOURCES } from "./model-path.js";
import type { AgentEvent } from "./protocol.js";
import {
  attachedPaths,
  briefForChecks,
  factsForChecks,
  missingPictures,
  picturesShown,
  readAttached,
  requestWords,
  type RequestSources,
} from "./request-facts.js";
import { createResourceLoader } from "./resource-loader.js";
import { SOURCE_FILE_HEAD } from "./source-file.js";
import { forwardChildToolEvents } from "./subagent-events.js";
import { makerVoice, runSubagent, type SubagentStop } from "./subagent-run.js";

const TIMEOUT_MS = 15 * 60 * 1000;

export interface DocsSystemContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  hostServices: HostServiceClient;
  skillPaths: string[];
  model?: unknown;
  /** The user's recent messages and what the bot read: what numbers are checked against. */
  requestSources?: () => RequestSources;
}

/** What the desktop's make step reports (docs-system/make.ts). */
export interface MadeFile {
  pdfPath: string | null;
  pptxPath: string | null;
  docxPath: string | null;
  pages: number;
  sums: { total: number | null; marks: number | null };
  sendBack: string[];
  dropped: string[];
  /** Charts of two values, printed as the numbers or left out (their captions). */
  notCharts?: string[];
  /** Weekdays the app corrected from their dates. */
  weekdaysFixed?: string[];
  /** Text over text or a chart, out of its box, or loose on a slide. */
  layout?: string[];
  /** Images that did not load. */
  images?: string[];
  /** The last print still drew text over text: its files were not kept. */
  failed?: string[];
}

/**
 * What the bot is told when the last print failed its layout check (round 4:
 * a deck with text printed over its cards was handed over as finished), or
 * null when a file was made.
 */
export const printFailure = (m: MadeFile | undefined): string | null =>
  m?.failed != null && m.failed.length > 0
    ? `The print failed, so no file was made: ${m.failed.join(" ")} Tell the user plainly that it could not be printed cleanly and what was wrong; do not hand over an older file or build one another way.`
    : null;

export interface DocsSystemResult {
  text: string;
  turns: number;
  stoppedBy: SubagentStop;
  made?: MadeFile;
  edited: boolean;
  prints: number;
}

/** Where a document's HTML source lives: beside the file, in `<name>-source/`. */
/**
 * A document's print is several page loads, fit passes, the PDF and the .docx:
 * past the host's default 2 minutes on a slow machine, which told the user it
 * failed while the files were still being written.
 */
const RENDER_DOCS_TIMEOUT_MS = 300_000;

export const sourceFor = (outputPath: string): string => {
  const base = outputPath.replace(/\.(pdf|pptx|docx)$/i, "");
  return path.join(`${base}-source`, `${path.basename(base)}.html`);
};

const IMG_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)("([^"]*)"|'([^']*)')/gi;

const isFile = (p: string): Promise<boolean> =>
  fs
    .stat(p)
    .then((s) => s.isFile())
    .catch(() => false);

/**
 * The user's own images, copied into `<source>/images/` with the page's `src`
 * pointing there. The model names a picture the way it opened it: from its own
 * folder, an absolute path or a file:// URL, but the page lives in its -source
 * folder (showcase O3: three slide pictures printed as broken icons). A source
 * that already resolves from the page, a web or data URL, is left alone; one
 * found nowhere is listed and left for the print to report.
 */
export const placeImages = async (
  html: string,
  sourceDir: string,
  bases: readonly string[]
): Promise<{ html: string; missing: string[] }> => {
  const placed = new Map<string, string>();
  const taken = new Set<string>();
  const missing: string[] = [];
  const target = async (src: string): Promise<string | null> => {
    if (src === "" || /^(https?:|data:|blob:|#)/i.test(src)) return null;
    let file = src;
    if (/^file:/i.test(src)) {
      try {
        file = fileURLToPath(src);
      } catch {
        return null;
      }
    } else if (src.startsWith("~/"))
      file = path.join(os.homedir(), src.slice(2));
    else {
      try {
        file = decodeURI(src);
      } catch {
        file = src;
      }
    }
    if (!path.isAbsolute(file) && (await isFile(path.join(sourceDir, file))))
      return null;
    const found = path.isAbsolute(file)
      ? (await isFile(file))
        ? file
        : null
      : await (async () => {
          for (const base of bases) {
            const p = path.resolve(base, file);
            if (await isFile(p)) return p;
          }
          return null;
        })();
    if (found == null) {
      if (!missing.includes(src)) missing.push(src);
      return null;
    }
    const known = placed.get(found);
    if (known != null) return known;
    const ext = path.extname(found);
    const stem = path.basename(found, ext);
    let name = `${stem}${ext}`;
    for (let i = 2; taken.has(name.toLowerCase()); i++)
      name = `${stem}-${i}${ext}`;
    taken.add(name.toLowerCase());
    await fs.mkdir(path.join(sourceDir, "images"), { recursive: true });
    await fs.copyFile(found, path.join(sourceDir, "images", name));
    const rel = `images/${name}`;
    placed.set(found, rel);
    return rel;
  };
  const parts: string[] = [];
  let last = 0;
  for (const m of html.matchAll(IMG_SRC)) {
    const src = (m[3] ?? m[4] ?? "").trim();
    const rel = await target(src);
    if (rel == null) continue;
    const quote = m[3] != null ? '"' : "'";
    parts.push(html.slice(last, m.index), m[1]!, `${quote}${rel}${quote}`);
    last = m.index! + m[0].length;
  }
  parts.push(html.slice(last));
  return { html: parts.join(""), missing };
};

/** The original request, kept beside the source. */
const briefFileFor = (sourcePath: string): string =>
  sourcePath.replace(/\.html$/, ".brief.txt");

/**
 * The page and layout to make, named in the task: it outranks the guide, so
 * an ask with its own layout says so (overnight: a menu and a CV were made as
 * plain documents because the task said "a document").
 */
export const pageAsk = (
  brief: string,
  kind: "doc" | "deck",
  slides?: number
): string => {
  if (kind === "deck")
    return `a slide deck (<body class="deck">)${slides != null ? ` of ${slides} slides` : ""}`;
  if (/\b(menu|price ?list)\b/i.test(brief))
    return 'a menu or price list on one poster page (<body class="doc bleed">, a .menu inside .poster)';
  if (/\bcertificate\b/i.test(brief))
    return 'a certificate on one A4 sheet turned sideways (<body class="doc bleed landscape">, a .certificate)';
  if (/\b(flyer|poster|notice)\b/i.test(brief))
    return 'a one-page poster (<body class="doc bleed">)';
  if (/\b(cv|resume|résumé)\b/i.test(brief))
    return 'a CV (<body class="doc">, the .cv-head and .cv-body layout)';
  if (
    /\bone[- ]page\b/i.test(brief) &&
    /\b(report|summary|dashboard|update)\b/i.test(brief)
  )
    return 'a one-page report (<body class="doc">, a summary band and .dash panels for the charts)';
  return 'a document (<body class="doc">)';
};

/** What the document's numbers were first checked against, kept for a change. */
const factsFileFor = (sourcePath: string): string =>
  sourcePath.replace(/\.html$/, ".facts.txt");

/**
 * The slides a change request names ("slide 4", "slides 2 and 5") whose markup
 * is the same in the new HTML as in the previous one.
 */
export const namedSlidesUnchanged = (
  request: string,
  previous: string,
  next: string
): number[] => {
  const named = new Set<number>();
  // The change asked, not the user's own file read into the brief after it,
  // whose "Slide 1:", "Slide 2:" lines named every slide.
  const own = request.indexOf(SOURCE_FILE_HEAD);
  for (const m of (own >= 0 ? request.slice(0, own) : request).matchAll(
    /\bslides?\s+((?:\d{1,2}(?:\s*(?:,|and|&)\s*)?)+)/gi
  ))
    for (const n of m[1]!.match(/\d{1,2}/g) ?? []) named.add(Number(n));
  if (named.size === 0) return [];
  const slides = (html: string): string[] =>
    [
      ...html.matchAll(
        /<section\b[^>]*\bclass="[^"]*\bslide\b[\s\S]*?<\/section>/gi
      ),
    ].map((m) => m[0].replace(/\s+/g, " "));
  const before = slides(previous);
  const after = slides(next);
  return [...named].filter(
    (n) => before[n - 1] != null && before[n - 1] === after[n - 1]
  );
};

const htmlOf = (text: string): string => {
  const fenced = text.match(/```html\s*\n([\s\S]*?)```/);
  return fenced ? fenced[1]! : text;
};

export async function runDocsSystemTask(
  context: DocsSystemContext,
  brief: string,
  outputPath: string,
  kind: "doc" | "deck",
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal,
  slides?: number,
  word?: boolean
): Promise<DocsSystemResult> {
  const sourcePath = sourceFor(outputPath);
  const outBase = outputPath.replace(/\.(pdf|pptx|docx)$/i, "");
  // A change starts from the source as it was last printed: after a refused
  // call the bot patched a report's source by hand, and the next change would
  // have printed that unchecked edit (hard asks).
  const onDisk = await fs.readFile(sourcePath, "utf8").catch(() => null);
  const printedCopy = await fs
    .readFile(`${sourcePath}.printed`, "utf8")
    .catch(() => null);
  const previous =
    onDisk != null && printedCopy != null && onDisk !== printedCopy
      ? printedCopy
      : onDisk;
  const original =
    previous != null
      ? await fs.readFile(briefFileFor(sourcePath), "utf8").catch(() => null)
      : null;
  const checkBrief = briefForChecks(original, brief);
  // Numbers are checked against the user and what the bot read, not the
  // bot's brief (live chat u05: its own "+5.6%" passed as given).
  const sources = context.requestSources?.();
  const keptFacts =
    previous != null
      ? await fs.readFile(factsFileFor(sourcePath), "utf8").catch(() => null)
      : null;
  const facts = factsForChecks({
    sources,
    files: await readAttached(attachedPaths(sources?.user ?? [])),
    brief,
    original: keptFacts ?? original,
  });
  const forwardTools = forwardChildToolEvents("doc", emit);
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  let guide = "";
  try {
    guide = String(await context.hostServices.request("docs_guide", {}));
  } catch (error) {
    return {
      text: `The design guide could not be read: ${error instanceof Error ? error.message : String(error)}`,
      turns: 0,
      stoppedBy: "error",
      edited: false,
      prints: 0,
    };
  }

  const attempts: Array<{ html: string; made: MadeFile }> = [];
  let final: MadeFile | null = null;

  const make = async (html: string, last: boolean): Promise<MadeFile> => {
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    // The page prints from its -source folder: the user's pictures go there.
    const placed = await placeImages(html, path.dirname(sourcePath), [
      context.cwd,
      path.dirname(outputPath),
    ]);
    await fs.writeFile(sourcePath, placed.html);
    if (previous == null) {
      await fs.writeFile(briefFileFor(sourcePath), brief);
      await fs.writeFile(factsFileFor(sourcePath), facts);
    }
    const made = (await context.hostServices.request(
      "render_docs",
      {
        htmlPath: sourcePath,
        outBase,
        kind,
        brief: checkBrief,
        facts,
        request: requestWords(sources, checkBrief),
        today,
        last,
        ...(slides != null ? { slides } : {}),
        ...(word === true ? { word: true } : {}),
      },
      RENDER_DOCS_TIMEOUT_MS
    )) as MadeFile;
    // The user's picture, asked for and left out (live chat photo deck).
    // Not on a change, which may be to take it out.
    let pictures =
      previous == null
        ? missingPictures(placed.html, brief, sources?.user ?? [])
        : [];
    // Shown under another name (live: northside-logo.png copied to logo.png).
    if (pictures.length > 0) {
      const candidates = [
        ...attachedPaths(sources?.user ?? []),
        ...pictures.flatMap((name) => [
          path.resolve(context.cwd, name),
          path.resolve(path.dirname(outputPath), name),
        ]),
      ];
      const shown = await picturesShown(
        candidates,
        placed.html,
        path.dirname(sourcePath)
      );
      pictures = pictures.filter((name) => !shown.includes(name));
    }
    if (pictures.length > 0)
      made.sendBack = [
        ...made.sendBack,
        `The request gives a picture the page does not show: ${pictures.join(", ")}. Put it in: a picture slide, a cover with a figure, or a figure beside the text.`,
      ];
    return made;
  };

  const files = (m: MadeFile): string =>
    [m.pptxPath, m.pdfPath, m.docxPath]
      .filter((f): f is string => f != null)
      .map((f) => modelPath(f))
      .join(", ");

  let unchangedChecked = false;
  const printTool = {
    name: "print",
    label: "print",
    description:
      "Print the document: pass the complete HTML file. The app fills the sums, draws the charts, fits the pages and prints. It says what it found; fix that and print once more if asked. The second print is the last.",
    parameters: Type.Object({
      html: Type.String({ description: "The complete HTML file." }),
    }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const html = htmlOf(typeof params.html === "string" ? params.html : "");
      if (!/<html|<body|<section/i.test(html))
        return {
          content: [
            {
              type: "text" as const,
              text: "That is not an HTML file. Pass the complete HTML.",
            },
          ],
          details: {},
          isError: true,
        };
      // A change that names a slide must change that slide: "make slide 4 a
      // chart" charted slide 3, and the deck was handed over as changed.
      if (previous != null && attempts.length === 0 && !unchangedChecked) {
        const same = namedSlidesUnchanged(brief, previous, html);
        if (same.length > 0) {
          unchangedChecked = true;
          return {
            content: [
              {
                type: "text" as const,
                text: `Not printed: ${same.map((n) => `slide ${n}`).join(", ")} ${same.length === 1 ? "is" : "are"} exactly as before, but the change asked is for ${same.length === 1 ? "it" : "them"} (counting the cover as slide 1). Make the change there, then call print again with the complete HTML.`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      }
      const last = attempts.length >= 1;
      let made = await make(html, last);
      attempts.push({ html, made });
      if (!last && made.sendBack.length > 0)
        return {
          content: [
            {
              type: "text" as const,
              text: `Printed (${files(made)}), but the app found:\n- ${made.sendBack.join("\n- ")}\n\nFix these and call print once more with the complete HTML. That print is the last.`,
            },
          ],
          details: {},
        };
      // Keep the better attempt: a retry can come back worse.
      const first = attempts[0]!;
      if (last && first.made.sendBack.length < made.sendBack.length) {
        made = await make(first.html, true);
      }
      final = made;
      await fs.copyFile(sourcePath, `${sourcePath}.printed`).catch(() => {});
      const failure = printFailure(made);
      if (failure != null)
        return {
          content: [
            {
              type: "text" as const,
              text: `${failure} Stop here and say in one line that it failed.`,
            },
          ],
          details: {},
        };
      return {
        content: [
          {
            type: "text" as const,
            text: `Printed: ${files(made)} (${made.pages} ${kind === "deck" ? "slides" : "pages"}).${made.sendBack.length > 0 ? ` Still open: ${made.sendBack.join(" ")}` : ""} Stop here and say in one line what you made.`,
          },
        ],
        details: {},
      };
    },
  };

  const what = pageAsk(brief, kind, slides);
  const task =
    previous != null
      ? [
          "This already exists. Its current HTML is below. Make the change the request asks for and keep everything else as it is: the layout, the wording, the numbers.",
          "",
          `The request:\n${brief}`,
          "",
          "Current HTML:",
          "```html",
          previous,
          "```",
          "",
          "Call print with the complete updated HTML.",
        ].join("\n")
      : [
          `Today is ${today}.`,
          "",
          `The request:\n${brief}`,
          "",
          `Make ${what}. Call print with the complete HTML file.`,
        ].join("\n");

  let run;
  try {
    const resourceLoader = createResourceLoader({
      ...MODEL_PATH_RESOURCES,
      cwd: context.cwd,
      agentDir: context.agentDir,
      settingsManager: context.settingsManager,
      additionalSkillPaths: context.skillPaths,
      systemPromptOverride: () => subAgentBasePrompt(true),
      appendSystemPrompt: [
        "You make finished documents and slide decks for people who will send or print them as they are.",
        guide,
      ],
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

    const created = await createAgentSession({
      cwd: context.cwd,
      agentDir: context.agentDir,
      modelRuntime: context.modelRuntime,
      resourceLoader,
      settingsManager: context.settingsManager,
      customTools: [printTool] as never,
      // Read only: the page is written through print, nothing else.
      excludeTools: ["bash", "edit", "write", ...excludedTools()],
      ...(context.model != null ? { model: context.model as never } : {}),
    });
    const session = created.session;
    try {
      run = await runSubagent(session, task, {
        tag: "doc",
        forwardTools,
        timeoutMs: TIMEOUT_MS,
        ...(signal != null ? { signal } : {}),
        voice: makerVoice("print"),
        isDone: () => final != null,
      });
    } finally {
      forwardTools.settle();
      session.abort();
    }
  } catch (error) {
    return {
      text: `The document sub-agent could not start: ${error instanceof Error ? error.message : String(error)}`,
      turns: 0,
      stoppedBy: "error",
      edited: previous != null,
      prints: attempts.length,
    };
  }

  // A run that printed once and stopped without the second print keeps the first.
  let made = final ?? attempts[attempts.length - 1]?.made;
  // Stopped after a first print that still drew text over text, or with an
  // image that did not load: that is a failed print too, and its files go.
  const broken = [...(made?.images ?? []), ...(made?.layout ?? [])];
  if (final == null && made != null && broken.length > 0) {
    for (const f of [made.pdfPath, made.pptxPath, made.docxPath])
      if (f != null) await fs.rm(f, { force: true });
    made = { ...made, failed: broken };
  }
  const failure = printFailure(made);
  if (failure != null)
    return {
      text: failure,
      turns: run.turns,
      stoppedBy: run.stoppedBy,
      edited: previous != null,
      prints: attempts.length,
    };
  return {
    text: run.text,
    turns: run.turns,
    stoppedBy: run.stoppedBy,
    ...(made != null ? { made } : {}),
    edited: previous != null,
    prints: attempts.length,
  };
}

/**
 * The document and ppt tools' design-system path: the run as a subtask, and
 * its result for the bot (nothing printed is an error).
 */
/** Output path -> the user message in whose turn its print passed. */
const passedIn = new Map<string, string>();

/** The current turn's user message, if the session gives one. */
export const turnOf = (context: {
  requestSources?: () => RequestSources;
}): string | null => context.requestSources?.().user.at(-1) ?? null;

/** Whether this file already passed its checks in this turn. */
/**
 * Keyed by kind (deck, doc), not path: a bot re-called ppt under v2, v3 and
 * -final names to slip past a per-file guard (live, stencil-tablet).
 */
export const passedThisTurn = (turn: string | null, kind: string): boolean =>
  turn != null && passedIn.get(kind) === turn;

export const markPassed = (turn: string | null, kind: string): void => {
  if (turn != null) passedIn.set(kind, turn);
};

export async function runDocsSystemTool(
  context: DocsSystemContext,
  o: {
    brief: string;
    outputPath: string;
    kind: "doc" | "deck";
    slides?: number;
    word?: boolean;
  },
  ev: {
    emit: (event: AgentEvent) => void;
    childEmit: (event: AgentEvent) => void;
    subtaskId: string;
    signal?: AbortSignal;
  }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}> {
  // A file that passed its checks is done for this turn: the bot re-printed
  // passed decks 2 to 6 times to polish them (deck-speed.md: 40-70% of an
  // own-file deck's time). A new user message opens it again.
  const turn = turnOf(context);
  if (passedThisTurn(turn, o.kind))
    return {
      content: [
        {
          type: "text",
          text: `A ${o.kind === "deck" ? "deck" : "document"} already passed the app's checks in this turn: it is done. Hand it over with present_deliverable now. Call ${o.kind === "deck" ? "ppt" : "document"} again only when the user asks for a change.`,
        },
      ],
      details: { stoppedBy: "passed" },
      isError: true,
    };
  let made: DocsSystemResult | undefined;
  let ok: "completed" | "failed" = "failed";
  try {
    made = await runDocsSystemTask(
      context,
      o.brief,
      o.outputPath,
      o.kind,
      ev.childEmit,
      ev.signal,
      o.slides,
      o.word
    );
    ok =
      made.made != null && made.stoppedBy !== "aborted"
        ? "completed"
        : "failed";
    if (made.text.trim().length > 0)
      ev.childEmit({ type: "text_delta", content: made.text });
  } finally {
    ev.emit({ type: "subtask_end", id: ev.subtaskId, status: ok });
  }
  if (made.made == null || made.stoppedBy === "aborted")
    return {
      content: [
        { type: "text", text: `Nothing was printed. ${made.text}`.trim() },
      ],
      details: { turns: made.turns, stoppedBy: made.stoppedBy },
      isError: true,
    };
  // A printed document is done for the turn even with a note left open: the
  // bot rewrote a 19-page report from scratch over one data-calc note (389 s,
  // comparison e4). Its reply says what is not right; the user asks again.
  if (
    made.made.pdfPath != null &&
    (made.made.sendBack.length === 0 || o.kind === "doc")
  )
    markPassed(turn, o.kind);
  return {
    content: [{ type: "text", text: docsSystemResultText(made, o.kind) }],
    details: {
      turns: made.turns,
      stoppedBy: made.stoppedBy,
      pdfPath: made.made.pdfPath,
      prints: made.prints,
      edited: made.edited,
    },
  };
}

/**
 * What the bot is told: the files, the checked facts (so its handover repeats
 * them rather than its own sums), anything still open, and how to change it.
 */
export const docsSystemResultText = (
  r: DocsSystemResult,
  kind: "doc" | "deck"
): string => {
  const m = r.made!;
  const unit = kind === "deck" ? "slides" : "pages";
  const lines = [
    `${r.edited ? "Changed and printed again" : "Made"}: ${m.pages} ${unit}.`,
    ...(m.pptxPath ? [`PowerPoint (editable): ${modelPath(m.pptxPath)}`] : []),
    ...(m.pdfPath ? [`PDF: ${modelPath(m.pdfPath)}`] : []),
    ...(m.docxPath ? [`Word: ${modelPath(m.docxPath)}`] : []),
    ...(m.sums.marks != null
      ? [`Marks, added up by the app: ${m.sums.marks}.`]
      : []),
    ...(m.dropped.length > 0
      ? [
          `Left out because a number in it was not in the request: ${m.dropped.join("; ")}. Tell the user what was left out and why, in one line, and offer to add it back if they give the figure.`,
        ]
      : []),
    // Weekdays are the app's to get right: corrected, and said, so the reply
    // does not repeat the wrong ones (a rota printed 2025's calendar).
    ...((m.weekdaysFixed ?? []).length > 0
      ? [
          `Weekdays corrected by the app from their dates: ${m.weekdaysFixed!.slice(0, 12).join("; ")}. Use these weekdays in your reply.`,
        ]
      : []),
    // A chart of two values is not drawn (it only repeats them): said, so a
    // "make slide 4 a chart" is not reported as a chart (hard asks).
    ...((m.notCharts ?? []).length > 0
      ? [
          `Not drawn as a chart, because two values make no chart and the numbers show instead: ${m.notCharts!.join("; ")}. If the user asked for a chart there, tell them so in one line and offer one with more values.`,
        ]
      : []),
    ...(m.sendBack.length > 0
      ? [
          `Not fixed: ${m.sendBack.join(" ")} Tell the user plainly what is not right yet; do not say the file is finished or unchanged.${kind === "doc" ? " Hand it over now and offer to fix it; do not call document again in this turn." : ""}`,
        ]
      : []),
    "",
    ...(m.sendBack.length === 0
      ? [
          `It passed the app's print checks (layout, fit, numbers, pictures): it is done. Hand it over now. Do not render, screenshot or inspect it yourself, and do not call ${kind === "deck" ? "ppt" : "document"} again in this turn to polish it.`,
        ]
      : []),
    `Hand over the format the user asked for with present_deliverable. Describe only what is listed here; the numbers above were checked by the app.`,
    `When the user asks for a change, call ${kind === "deck" ? "ppt" : "document"} again with the same output_path and the change ("change slide 3's title to …", "add a cover"); the app edits its own source and prints again. Do not edit or rebuild the files yourself.`,
    ...(m.pdfPath
      ? [
          `Page numbers and page breaks exist only in the PDF: a preview image is one screen of the page and shows neither. Do not judge the file by the PDF's extracted text either: Bengali, Devanagari and other shaped scripts always read back garbled, but print correctly. If something is wrong, call ${kind === "deck" ? "ppt" : "document"} again with the change.`,
        ]
      : []),
  ];
  return lines.join("\n");
};
