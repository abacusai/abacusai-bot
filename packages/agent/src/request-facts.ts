/**
 * What a document's numbers are checked against: the user's own words, the
 * plain-text files they attached, and what the bot read for them (tool
 * results: a file, a search, a page). Never the bot's own words or its brief
 * to the document tool: live (chat u05), the bot worked out "+5.6%" itself
 * (it is +8.4%), wrote it into the brief, and the check let it through.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { textOf } from "./compaction-anchor.js";
import { userTurnText } from "./user-text.js";

const contentText = (message: unknown): string =>
  textOf((message as { content?: unknown } | null)?.content);

/**
 * The brief the app checks against: for a change, the original request and
 * the change together. A change alone ("slide 3's title …") holds none of the
 * document's figures, so they would read as made up.
 */
export const briefForChecks = (
  original: string | null,
  brief: string
): string =>
  original == null ? brief : `${original}\n\nChange asked later: ${brief}`;

export interface RequestSources {
  /** The user's own messages, newest last, as they sent them. */
  user: string[];
  /** What tools returned to the bot over the same turns. */
  read: string[];
}

/** User turns looked back over: the request and a few follow-ups. */
const TURNS = 6;
/** Enough for long notes or a few search results; past this it is noise. */
const MAX_CHARS = 400_000;

/** The last few user turns of a session, and the tool results among them. */
export const requestSources = (
  messages: readonly unknown[]
): RequestSources => {
  const user: string[] = [];
  const read: string[] = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0 && user.length < TURNS; i--) {
    const role = (messages[i] as { role?: unknown } | null)?.role;
    if (role !== "user" && role !== "toolResult") continue;
    const text =
      role === "user"
        ? userTurnText(contentText(messages[i]))
        : contentText(messages[i]);
    if (text.trim().length === 0 || size + text.length > MAX_CHARS) continue;
    size += text.length;
    (role === "user" ? user : read).unshift(text);
  }
  return { user, read };
};

/** Files the user attached: "@/path" lines (desktop) and "[attachment: path]" (channels). */
export const attachedPaths = (userTexts: readonly string[]): string[] => {
  const out: string[] = [];
  for (const text of userTexts)
    for (const line of text.split("\n")) {
      const m =
        /^\s*@(\S.*?)\s*$/.exec(line) ??
        /^\s*\[attachment:\s*([^\]\n]+?)\s*\]\s*$/.exec(line);
      const p = m?.[1];
      if (p != null && path.isAbsolute(p) && !out.includes(p)) out.push(p);
    }
  return out;
};

const PLAIN = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml)$/i;

/** The text of the attached files that are plain text; others are read by the bot, and its reads count. */
export const readAttached = async (
  paths: readonly string[]
): Promise<string[]> => {
  const out: string[] = [];
  for (const p of paths) {
    if (!PLAIN.test(p)) continue;
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      out.push(await fs.readFile(p, "utf8"));
    } catch {
      // Gone or unreadable: nothing of it counts.
    }
  }
  return out;
};

/**
 * The text a document's numbers must come from. A turn the app started (a
 * routine) has no user words: the brief is all there is. A change keeps what
 * the document was first checked against.
 */
export const factsForChecks = (o: {
  sources: RequestSources | undefined;
  files: readonly string[];
  brief: string;
  original: string | null;
}): string => {
  const own = o.sources?.user.filter((t) => t.trim().length > 0) ?? [];
  if (own.length === 0) return briefForChecks(o.original, o.brief);
  // A deck, PDF or picture the user attached is read only by the bot, so its
  // figures reach the page through the brief (final round: a chart picture's
  // bike counts in the user's own .pptx were left out).
  const opaque = attachedPaths(own).some((p) => !PLAIN.test(p));
  return [
    o.original ?? "",
    ...own,
    ...o.files,
    ...(o.sources?.read ?? []),
    ...(opaque ? [o.brief] : []),
  ]
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
};

const PICTURE = /[\w.~/@%+-]*?([\w.%+-]+\.(?:jpe?g|png|webp|gif))\b/gi;

/**
 * Pictures the request gives (named in the brief, or attached by the user)
 * that the page does not show, by file name. Live (chat photo deck): the
 * photo was asked for and attached, the deck had none, and the chat said it
 * was on the cover.
 */
export const missingPictures = (
  html: string,
  brief: string,
  userTexts: readonly string[]
): string[] => {
  const wanted = new Set<string>();
  for (const m of brief.matchAll(PICTURE)) wanted.add(m[1]!);
  for (const p of attachedPaths(userTexts)) {
    const name = path.basename(p);
    if (/\.(jpe?g|png|webp|gif)$/i.test(name)) wanted.add(name);
  }
  const shown = new Set(
    [...html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)].map((m) =>
      path.basename(decodeURI(m[1]!))
    )
  );
  return [...wanted].filter((name) => !shown.has(name));
};

/**
 * The user's own words, for the chart rule: not tool output (a file listing's
 * sizes) and not the bot's brief (it called a photo "a 1200x800 JPEG"). The
 * brief when the app started the turn.
 */
export const requestWords = (
  sources: RequestSources | undefined,
  brief: string
): string => {
  const own = sources?.user.filter((t) => t.trim().length > 0) ?? [];
  // Without the attached files' paths: their digits are not figures.
  const words = own.map((t) =>
    t
      .split("\n")
      .filter(
        (line) =>
          !/^\s*@\S/.test(line) && !/^\s*\[attachment(?: not read)?:/.test(line)
      )
      .join("\n")
      .trim()
  );
  return own.length > 0 ? words.join("\n\n") : brief;
};

const digest = async (file: string): Promise<string | null> =>
  fs
    .readFile(file)
    .then((b) => crypto.createHash("sha256").update(b).digest("hex"))
    .catch(() => null);

/**
 * Which of the user's pictures the page shows under another name: the bot
 * may copy northside-logo.png to logo.png (live chat certificate, where the
 * name check called the logo missing). Compared by content.
 */
export const picturesShown = async (
  pictures: readonly string[],
  html: string,
  sourceDir: string
): Promise<string[]> => {
  const onPage = new Set<string>();
  for (const m of html.matchAll(
    /<img\b[^>]*?\ssrc\s*=\s*["']([^"':]+)["']/gi
  )) {
    const d = await digest(path.resolve(sourceDir, m[1]!));
    if (d != null) onPage.add(d);
  }
  const shown: string[] = [];
  for (const p of pictures) {
    const d = await digest(p);
    if (d != null && onPage.has(d)) shown.push(path.basename(p));
  }
  return shown;
};
