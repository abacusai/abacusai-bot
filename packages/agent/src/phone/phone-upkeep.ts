/**
 * The phone loop's writing path outside of tools: the JSON a flush or a
 * consolidation turn returns is validated, deduped and capped here before it
 * touches memory, and every message reaches the append-only archive, live
 * and again (deduped) just before a compaction drops it.
 */
import { createHash } from "crypto";

import { BotOutputSanitizer } from "../bot/bot-output.js";
import { DAY_MS, localDay } from "./phone-config.js";
import {
  aboutYouEntries,
  appendArchive,
  appendLog,
  type ArchiveEntry,
  clip,
  dedupeKey,
  FACT_MAX_CHARS,
  flatten,
  forgetFact,
  isIsoDate,
  listNotes,
  LOOP_MAX_CHARS,
  mergeNotes,
  NOTE_ENTRY_MAX_CHARS,
  promoteStory,
  readArchive,
  readLogLines,
  rememberFact,
  resolveLoop,
  sortedOpenLoops,
  stageStory,
  trackLoop,
  writeTopicNote,
} from "./phone-memory.js";
import {
  type ConsolidationInput,
  PHONE_CONSOLIDATE_TYPE,
  PHONE_FLUSH_TYPE,
} from "./phone-prompts.js";

const HIDDEN_TURN_TYPES = new Set([PHONE_FLUSH_TYPE, PHONE_CONSOLIDATE_TYPE]);

/** How many items one flush may write per field. */
const FLUSH_MAX_ITEMS = 8;
const FLUSH_MAX_LOG_LINES = 12;
const CONSOLIDATE_MAX_ITEMS = 10;
/** The missing day's messages shown to the consolidation turn, newest kept. */
const CONSOLIDATE_TRANSCRIPT_CHARS = 4_000;

/** The JSON object in a model reply: reasoning tags and code fences ignored. */
export function parseJsonReply(reply: string): Record<string, unknown> | null {
  const bare = reply.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, "");
  const start = bare.indexOf("{");
  const end = bare.lastIndexOf("}");

  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(bare.slice(start, end + 1));

    return parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A list of strings, [] when absent, null when it is something else. */
function strings(value: unknown, max: number): string[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;

  return value
    .filter((item): item is string => typeof item === "string")
    .map(flatten)
    .filter((item) => item.length > 0)
    .slice(0, max);
}

function objects(
  value: unknown,
  max: number
): Array<Record<string, unknown>> | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        item != null && typeof item === "object"
    )
    .slice(0, max);
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

export interface FlushPayload {
  aboutYou: string[];
  loopsAdd: Array<{ text: string; due?: string }>;
  loopsResolve: string[];
  notes: Array<{ topic: string; text: string }>;
  log: string[];
  story: string;
}

/** The flush reply as a payload, or null when it is not the agreed shape. */
export function validateFlush(reply: string): FlushPayload | null {
  const parsed = parseJsonReply(reply);

  if (parsed == null) return null;

  const loops = parsed.loops ?? {};

  if (typeof loops !== "object" || Array.isArray(loops)) return null;

  const { add, resolve } = loops as Record<string, unknown>;
  const aboutYou = strings(parsed.about_you, FLUSH_MAX_ITEMS);
  const loopsAdd = objects(
    Array.isArray(add)
      ? add.map((item) => (typeof item === "string" ? { text: item } : item))
      : add,
    FLUSH_MAX_ITEMS
  );
  const loopsResolve = strings(resolve, CONSOLIDATE_MAX_ITEMS * 2);
  const notes = objects(parsed.notes, FLUSH_MAX_ITEMS);
  const log = strings(parsed.log, FLUSH_MAX_LOG_LINES);

  if (
    aboutYou == null ||
    loopsAdd == null ||
    loopsResolve == null ||
    notes == null ||
    log == null ||
    (parsed.story != null && typeof parsed.story !== "string")
  )
    return null;

  return {
    aboutYou: aboutYou.map((fact) => clip(fact, FACT_MAX_CHARS)),
    loopsAdd: loopsAdd
      .map((loop) => ({
        text: clip(flatten(str(loop.text)), LOOP_MAX_CHARS),
        due: str(loop.due).trim(),
      }))
      .filter((loop) => loop.text.length > 0)
      .map((loop) => (isIsoDate(loop.due) ? loop : { text: loop.text })),
    loopsResolve,
    notes: notes
      .map((note) => ({
        topic: flatten(str(note.topic)),
        text: clip(flatten(str(note.text)), NOTE_ENTRY_MAX_CHARS),
      }))
      .filter((note) => note.topic.length > 0 && note.text.length > 0),
    log,
    story: str(parsed.story),
  };
}

/** Writes a valid flush; false (retried next turn) when the reply was not one. */
export async function applyFlush(
  dir: string,
  reply: string,
  now: Date
): Promise<boolean> {
  const payload = validateFlush(reply);

  if (payload == null) return false;

  for (const fact of payload.aboutYou) await rememberFact(fact);
  for (const id of payload.loopsResolve) resolveLoop(dir, id, now);
  for (const loop of payload.loopsAdd) trackLoop(dir, loop, now);
  for (const note of payload.notes) writeTopicNote(dir, note);
  appendLog(dir, localDay(now), payload.log);
  stageStory(dir, payload.story);

  return true;
}

// ------------------------------------------------------------- consolidation

const timeOf = (iso: string): string => {
  const date = new Date(iso);

  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** What the consolidation turn is shown, for the day before `now`. */
export function consolidationInput(dir: string, now: Date): ConsolidationInput {
  const day = localDay(new Date(now.getTime() - DAY_MS));
  const messages = readArchive(dir, day.slice(0, 7)).filter(
    (entry) => localDay(new Date(entry.ts)) === day
  );
  let transcript = messages
    .map(
      (entry) =>
        `[${timeOf(entry.ts)} ${entry.role === "user" ? "user" : "you"}] ${flatten(entry.text)}`
    )
    .join("\n");

  if (transcript.length > CONSOLIDATE_TRANSCRIPT_CHARS)
    transcript = `…${transcript.slice(-CONSOLIDATE_TRANSCRIPT_CHARS)}`;

  return {
    missingDay:
      messages.length > 0 && readLogLines(dir, day).length === 0
        ? { day, transcript }
        : null,
    aboutYou: aboutYouEntries(),
    notes: listNotes(dir).map(
      (note) => `${note.title}: ${clip(flatten(note.body), 160)}`
    ),
    loops: sortedOpenLoops(dir).map(
      (loop) =>
        `[${loop.id}] ${loop.text} (open since ${loop.created.slice(0, 10)})`
    ),
  };
}

/** Applies a consolidation reply; false when it was not the agreed shape. */
export async function applyConsolidation(
  dir: string,
  reply: string,
  input: ConsolidationInput,
  now: Date
): Promise<boolean> {
  const parsed = parseJsonReply(reply);

  if (parsed == null) return false;

  const log = strings(parsed.log, FLUSH_MAX_LOG_LINES);
  const remove = strings(parsed.about_you_remove, CONSOLIDATE_MAX_ITEMS);
  const merges = objects(parsed.notes_merge, CONSOLIDATE_MAX_ITEMS);
  const resolve = strings(parsed.loops_resolve, CONSOLIDATE_MAX_ITEMS * 2);

  if (log == null || remove == null || merges == null || resolve == null)
    return false;

  if (
    input.missingDay != null &&
    readLogLines(dir, input.missingDay.day).length === 0
  )
    appendLog(dir, input.missingDay.day, log);

  // Only an exact match is removed: a fragment could take a different fact.
  for (const text of remove) {
    const entry = aboutYouEntries().find(
      (fact) => dedupeKey(fact) === dedupeKey(text)
    );

    if (entry != null) await forgetFact(entry);
  }
  for (const merge of merges) mergeNotes(dir, str(merge.from), str(merge.into));
  for (const id of resolve) resolveLoop(dir, id, now);

  return true;
}

// ------------------------------------------------------------------ archive

/** A user or assistant message as an archive entry; null for anything else. */
function toArchiveEntry(message: unknown): ArchiveEntry | null {
  const { role, content, timestamp } = (message ?? {}) as {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
  };

  if (role !== "user" && role !== "assistant") return null;

  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => (block as { type?: unknown })?.type === "text")
            .map((block) => str((block as { text?: unknown }).text))
            .join("")
        : "";
  let text = raw;

  if (role === "assistant") {
    // Leaked reasoning is not part of what was said.
    const sanitizer = new BotOutputSanitizer();
    text = sanitizer.push(raw).text + sanitizer.flush().text;
  }

  text = text.trim();

  if (text.length === 0) return null;

  const ms = typeof timestamp === "number" ? timestamp : Date.now();

  const digest = createHash("sha1").update(text).digest("hex").slice(0, 10);

  return {
    ts: new Date(ms).toISOString(),
    role,
    text,
    key: `${role}:${ms}:${digest}`,
  };
}

/** A message as it ends, so a crash never loses the raw thread. */
export function archiveLive(dir: string, message: unknown): void {
  const entry = toArchiveEntry(message);

  if (entry != null) appendArchive(dir, [entry], false);
}

/** Before a compaction: archive what it drops, then promote the staged story. */
export function beforePhoneCompaction(
  dir: string,
  messages: readonly unknown[]
): void {
  appendArchive(dir, conversationEntries(messages));
  promoteStory(dir);
}

/** The archive entries in a transcript, leaving out hidden housekeeping turns. */
function conversationEntries(messages: readonly unknown[]): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let hidden = false;

  for (const message of messages) {
    const { role, customType } = (message ?? {}) as {
      role?: unknown;
      customType?: unknown;
    };

    // A hidden turn runs from its custom message to the next user message.
    if (role === "custom") hidden = HIDDEN_TURN_TYPES.has(String(customType));
    else if (role === "user") hidden = false;

    const entry = hidden ? null : toArchiveEntry(message);

    if (entry != null) entries.push(entry);
  }

  return entries;
}
