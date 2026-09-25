/**
 * Searching past conversations across two stores: desktop transcripts
 * (`<home>/transcripts/<session>.json`) and pi's session logs
 * (`<home>/agent/sessions/<cwd>/*.jsonl`). A desktop session owns several logs,
 * so logs `local-code.json` claims are skipped in favour of the transcript;
 * unclaimed logs are reported even when that duplicates a conversation, since
 * one that cannot be found is worse than one found twice. Substring match only.
 */
import fs from "fs";
import path from "path";

import { abacusBotDir, agentDir } from "./config.js";

/** Excerpts per session. Enough to show relevance; more is padding. */
const MAX_EXCERPTS = 3;
/** Characters of context kept before and after the match. */
const LEAD = 80;
const TRAIL = 120;

export interface SessionHit {
  /** The session's own id: the desktop's for a transcript, pi's for a log. */
  sessionId: string;
  /** Where it came from, so a result can say so. */
  origin: "desktop" | "agent-log";
  /** Milliseconds since the epoch. 0 when nothing on disk said. */
  updatedAt: number;
  /** The label the user gave it, or the directory it ran in. */
  title: string | null;
  /** Matching lines, already trimmed to something readable. */
  excerpts: string[];
}

const transcriptsDir = (): string => path.join(abacusBotDir(), "transcripts");
const sessionLogsDir = (): string => path.join(agentDir(), "sessions");

/**
 * Keys whose values are never what someone is searching for: ids and
 * timestamps match a query by accident, and `updatedAt` sits at the top of
 * every transcript, so a date query would return every session that existed.
 */
const SKIPPED_KEYS = new Set([
  // Ids and timestamps.
  "id",
  "sessionId",
  "workspaceId",
  "parentId",
  "timestamp",
  "createdAt",
  "updatedAt",
  "version",
  // Structural labels: `type`, `role` and `source` are the words "text", "user"
  // and "bot", which a real query would otherwise match in every session.
  "type",
  "role",
  "source",
  "kind",
  "status",
  // Which provider answered, which is bookkeeping rather than conversation.
  "api",
  "provider",
  "model",
  "modelId",
  "stopReason",
  "rawStopReason",
  "responseId",
]);

/**
 * Pull readable text out of one transcript segment. Segments are deliberately
 * loose `Record<string, unknown>`, so this walks the value rather than reaching
 * for known keys and finds no text in a shape it does not understand.
 */
export const textOf = (value: unknown, depth = 0): string[] => {
  if (depth > 6) return [];
  if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
  if (Array.isArray(value))
    return value.flatMap((entry) => textOf(entry, depth + 1));

  if (value != null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SKIPPED_KEYS.has(key))
      .flatMap(([, entry]) => textOf(entry, depth + 1));
  }

  return [];
};

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/**
 * Slice bounds moved off the middle of a surrogate pair: an astral character is
 * two offsets, and cutting between them leaves an unpaired surrogate no encoder
 * downstream should be handed. Both ends move outward, keeping it whole.
 */
const wholeCharacters = (
  text: string,
  start: number,
  end: number
): [number, number] => {
  const from =
    start > 0 && isLowSurrogate(text.charCodeAt(start)) ? start - 1 : start;
  const to =
    end < text.length && isHighSurrogate(text.charCodeAt(end - 1))
      ? end + 1
      : end;

  return [from, to];
};

const excerptAround = (text: string, needle: string): string => {
  const at = text.toLowerCase().indexOf(needle);
  const [start, end] = wholeCharacters(
    text,
    Math.max(0, at - LEAD),
    Math.min(text.length, at + needle.length + TRAIL)
  );
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();

  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
};

/**
 * The first few distinct matches in a value, however deeply buried. Distinct
 * because a conversation repeats itself (a command run twice, a tool call and
 * its echo), and three copies of one line spend the budget saying nothing.
 */
const excerptsIn = (value: unknown, needle: string): string[] => {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const text of textOf(value)) {
    if (!text.toLowerCase().includes(needle)) continue;

    const excerpt = excerptAround(text, needle);
    if (seen.has(excerpt)) continue;

    seen.add(excerpt);
    found.push(excerpt);
    if (found.length >= MAX_EXCERPTS) break;
  }

  return found;
};

const parseTime = (value: unknown): number => {
  if (typeof value !== "string") return 0;
  const at = Date.parse(value);

  return Number.isNaN(at) ? 0 : at;
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A half-written file must not take the search down; missing is normal on
    // a fresh install.
    return null;
  }
};

interface DesktopSession {
  label?: unknown;
  updatedAt?: unknown;
  agentSessionId?: unknown;
  agentSessionIds?: unknown;
  agentSessionFile?: unknown;
}

/**
 * What the app knows about its own sessions: label, when the conversation last
 * moved, and which agent logs it owns. The stored `updatedAt` beats the file's
 * mtime because the app rewrites every transcript when it restores them at
 * launch, which would reshuffle the results on every open.
 */
const readDesktopSessions = (): Map<string, DesktopSession> => {
  const parsed = readJson(path.join(abacusBotDir(), "local-code.json"));
  const sessions = (parsed as { agent?: { agentSessions?: unknown } } | null)
    ?.agent?.agentSessions;
  const byId = new Map<string, DesktopSession>();

  if (!Array.isArray(sessions)) return byId;

  for (const entry of sessions) {
    if (entry == null || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string") byId.set(id, entry as DesktopSession);
  }

  return byId;
};

/** Every agent session id the app has claimed for a session of its own. */
const claimedLogIds = (sessions: Map<string, DesktopSession>): Set<string> => {
  const claimed = new Set<string>();

  for (const session of sessions.values()) {
    // `agentSessionIds` holds every log the session opened; `agentSessionId` is
    // the latest, and all that older stores recorded.
    if (Array.isArray(session.agentSessionIds)) {
      for (const id of session.agentSessionIds) {
        if (typeof id === "string") claimed.add(id);
      }
    }
    if (typeof session.agentSessionId === "string")
      claimed.add(session.agentSessionId);
  }

  return claimed;
};

/**
 * The app session running a given agent session, if any. Used to leave the
 * conversation asking the question out of its own results, which every query
 * would otherwise match.
 */
const ownerOf = (
  sessions: Map<string, DesktopSession>,
  agentSessionId: string
): string | null => {
  for (const [id, session] of sessions) {
    if (session.agentSessionId === agentSessionId) return id;
    if (
      Array.isArray(session.agentSessionIds) &&
      session.agentSessionIds.includes(agentSessionId)
    )
      return id;
  }

  return null;
};

const searchTranscripts = (needle: string, skip: Set<string>): SessionHit[] => {
  let files: string[];

  try {
    files = fs
      .readdirSync(transcriptsDir())
      .filter((name) => name.endsWith(".json"));
  } catch {
    // No transcripts directory is the normal state before the app has written
    // one, not an error.
    return [];
  }

  const sessions = readDesktopSessions();
  const hits: SessionHit[] = [];

  for (const name of files) {
    const file = path.join(transcriptsDir(), name);
    const parsed = readJson(file);
    if (parsed == null) continue;

    const sessionId = path.basename(name, ".json");
    if (skip.has(sessionId)) continue;

    const excerpts = excerptsIn(
      (parsed as { segments?: unknown }).segments,
      needle
    );
    if (excerpts.length === 0) continue;

    const session = sessions.get(sessionId);
    const label = typeof session?.label === "string" ? session.label : null;

    hits.push({
      sessionId,
      origin: "desktop",
      updatedAt:
        parseTime(session?.updatedAt) ||
        parseTime((parsed as { updatedAt?: unknown }).updatedAt) ||
        mtimeOf(file),
      title: label,
      excerpts,
    });
  }

  return hits;
};

const mtimeOf = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    // stat can fail if the file vanished mid-scan; treat it as oldest.
    return 0;
  }
};

/** Every `.jsonl` under the session directory: one level of cwd folders. */
const sessionLogFiles = (): string[] => {
  const root = sessionLogsDir();
  let folders: fs.Dirent[];

  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    try {
      for (const name of fs.readdirSync(path.join(root, folder.name))) {
        if (name.endsWith(".jsonl"))
          files.push(path.join(root, folder.name, name));
      }
    } catch {
      // A directory that vanished between the two reads is not worth failing
      // the search over.
      continue;
    }
  }

  return files;
};

/**
 * Whether JSON writes this string to a file unchanged, so the raw text can be
 * tested directly. Quotes, backslashes and control characters are escaped.
 */
const storedVerbatim = (needle: string): boolean =>
  !needle
    .split("")
    .some(
      (character) =>
        character === '"' ||
        character === "\\" ||
        character.charCodeAt(0) < 0x20
    );

interface LogEntry {
  type?: unknown;
  cwd?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

const searchSessionLogs = (needle: string, skip: Set<string>): SessionHit[] => {
  const hits: SessionHit[] = [];

  for (const file of sessionLogFiles()) {
    let contents: string;

    try {
      contents = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // Cheap reject first: parsing every line of every log is the whole cost of
    // the search. Only sound for a needle JSON stores verbatim, since an
    // escaped quote or backslash on disk would reject a file that does match.
    if (storedVerbatim(needle) && !contents.toLowerCase().includes(needle))
      continue;

    let sessionId = path.basename(file, ".jsonl");
    let cwd: string | null = null;
    let updatedAt = 0;
    const excerpts: string[] = [];
    // Each entry is excerpted on its own, so distinctness is kept across them.
    const seen = new Set<string>();

    for (const line of contents.split("\n")) {
      if (line.length === 0) continue;

      let entry: LogEntry | null;

      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        // The last line of a log being written right now can be half there;
        // every earlier line is still good.
        continue;
      }

      if (entry?.type === "session") {
        if (typeof entry.id === "string") sessionId = entry.id;
        if (typeof entry.cwd === "string") cwd = entry.cwd;
      }

      const at = parseTime(entry?.timestamp);
      if (at > updatedAt) updatedAt = at;

      if (entry?.type !== "message" || excerpts.length >= MAX_EXCERPTS)
        continue;

      for (const excerpt of excerptsIn(entry.message, needle)) {
        if (seen.has(excerpt)) continue;

        seen.add(excerpt);
        excerpts.push(excerpt);
        if (excerpts.length >= MAX_EXCERPTS) break;
      }
    }

    // The id comes from the header inside the file, not its name, so ownership
    // is decided on the id the app recorded.
    if (excerpts.length === 0 || skip.has(sessionId)) continue;

    hits.push({
      sessionId,
      origin: "agent-log",
      updatedAt: updatedAt || mtimeOf(file),
      title: cwd,
      excerpts,
    });
  }

  return hits;
};

/**
 * @param currentSessionId  The agent session doing the asking, left out along
 *   with the app conversation running it.
 */
export const searchSessions = (
  query: string,
  limit = 10,
  currentSessionId?: string
): SessionHit[] => {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) return [];

  const sessions = readDesktopSessions();
  const claimedLogs = claimedLogIds(sessions);
  const skippedTranscripts = new Set<string>();

  if (currentSessionId != null && currentSessionId.length > 0) {
    claimedLogs.add(currentSessionId);
    const owner = ownerOf(sessions, currentSessionId);
    if (owner != null) skippedTranscripts.add(owner);
  }

  // Most recent first: "the last time I dealt with this" is almost always the
  // one being looked for.
  return [
    ...searchTranscripts(needle, skippedTranscripts),
    ...searchSessionLogs(needle, claimedLogs),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
};

export const renderHits = (hits: SessionHit[], query: string): string => {
  if (hits.length === 0) return `Nothing in past sessions mentions "${query}".`;

  return hits
    .map((hit) => {
      // An unknown time would otherwise render as 1970-01-01 and read as real.
      const when =
        hit.updatedAt > 0
          ? new Date(hit.updatedAt).toISOString().slice(0, 16).replace("T", " ")
          : "unknown";
      const where = hit.origin === "desktop" ? "app" : "agent log";
      const heading = [
        `session ${hit.sessionId}`,
        `(${when}, ${where})`,
        hit.title,
      ].filter((part) => part != null);

      return [
        heading.join(" "),
        ...hit.excerpts.map((excerpt) => `  ${excerpt}`),
      ].join("\n");
    })
    .join("\n\n");
};
