/**
 * Walking `transcripts/` (and, for step 4, `threads/`) for steps 1 and 4
 * (spec 00 C.3, C.5): one file at a time. Only what the rules need is kept
 * per file: the v1 text is dropped once parsed, and the twin is reduced to
 * its source, so peak memory is one v1 file's parse plus its conversion,
 * never the directory. A v1 file over `MAX_TRANSCRIPT_BYTES` is not read.
 */
import fs from "node:fs";
import path from "node:path";

import {
  parseTranscriptV1,
  type ClearMarker,
  type ThreadTwinSummary,
} from "#shared/transcript/thread-file";

import {
  clearMarkerPath,
  fingerprintV1,
  isProvenAfterClear,
  isSafeSessionId,
  MAX_TRANSCRIPT_BYTES,
  parseMarkerRead,
  readTextChecked,
  readThreadTwin,
  THREADS_DIR_NAME,
  TRANSCRIPTS_DIR_NAME,
  v1UpdatedAt,
} from "../../services/session/thread-store";

/** Yield to the event loop this often, so the progress window paints. */
export const YIELD_EVERY = 20;

export const transcriptsDir = (home: string): string =>
  path.join(home, TRANSCRIPTS_DIR_NAME);

export const threadsDir = (home: string): string =>
  path.join(home, THREADS_DIR_NAME);

/**
 * The `*.json` regular files of a folder, sorted. Anything else (an
 * atomic-write temp file, `.DS_Store`, a clear marker, a folder) is left
 * alone.
 */
const listJsonFiles = (
  dir: string,
  options: { symlinks: boolean; strict?: boolean }
): string[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // Only a folder that is not there is empty. Anything else (EACCES, EIO)
    // stops the step: an unlisted transcript would make its twin look
    // orphaned.
    if (
      options.strict !== true ||
      (error as { code?: unknown })?.code === "ENOENT"
    )
      return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        (entry.isFile() || (options.symlinks && entry.isSymbolicLink())) &&
        entry.name.endsWith(".json")
    )
    .map((entry) => entry.name)
    .sort();
};

/** The v1 files, symlinked ones included (reading follows the link). */
export const listTranscriptFiles = (
  home: string,
  { strict = true } = {}
): string[] => listJsonFiles(transcriptsDir(home), { symlinks: true, strict });

export const listThreadFiles = (home: string): string[] =>
  listJsonFiles(threadsDir(home), { symlinks: false, strict: true });

/**
 * Whether nothing at all is at `transcripts/<id>.json` (not a file, a
 * folder, a link or anything that cannot be stat'ed): only then can its
 * twin be an orphan.
 */
export const v1PathIsAbsent = (home: string, sessionId: string): boolean => {
  try {
    fs.lstatSync(path.join(transcriptsDir(home), `${sessionId}.json`));
    return false;
  } catch (error) {
    return (error as { code?: unknown })?.code === "ENOENT";
  }
};

/** The twin reduced to what the rules read (the parsed file is dropped). */
export const readTwinSummary = (file: string): ThreadTwinSummary => {
  const twin = readThreadTwin(file);
  return twin.status === "ok" ? { status: "ok", source: twin.source } : twin;
};

/** The thread's clear marker, if any (a damaged one still means cleared). */
export const readClearMarker = (
  home: string,
  sessionId: string
): ClearMarker | null =>
  parseMarkerRead(
    readTextChecked(clearMarkerPath(threadsDir(home), sessionId))
  );

export type InspectedTranscript =
  | { status: "unsafe"; name: string; file: string }
  | { status: "corrupt"; name: string; file: string }
  | { status: "not-v1"; name: string; file: string }
  /** Gone since the directory was listed. */
  | { status: "vanished"; name: string; file: string }
  /** Exists but cannot be read (EACCES, EBUSY, …): kept, never quarantined. */
  | { status: "unreadable"; name: string; file: string; error: string }
  /** Over `MAX_TRANSCRIPT_BYTES`: kept, never converted or quarantined. */
  | { status: "tooLarge"; name: string; file: string; size: number }
  | {
      status: "ok";
      name: string;
      file: string;
      sessionId: string;
      updatedAt: string;
      fingerprint: string;
      segments: unknown[];
      twinFile: string;
      twin: ThreadTwinSummary;
      marker: ClearMarker | null;
    };

/** Reads one v1 file and its v2 twin. Never throws for bad content. */
export const inspectTranscript = (
  home: string,
  name: string,
  maxBytes = MAX_TRANSCRIPT_BYTES
): InspectedTranscript => {
  const file = path.join(transcriptsDir(home), name);
  const sessionId = name.slice(0, -".json".length);
  if (!isSafeSessionId(sessionId)) return { status: "unsafe", name, file };
  const read = readTextChecked(file, maxBytes);
  switch (read.status) {
    case "missing":
      return { status: "vanished", name, file };
    case "unreadable":
      return { status: "unreadable", name, file, error: read.error };
    case "tooLarge":
      return { status: "tooLarge", name, file, size: read.size };
    case "ok":
      break;
  }
  const parsed = parseTranscriptV1(read.text);
  if (parsed.status !== "ok") return { status: parsed.status, name, file };
  const twinFile = path.join(threadsDir(home), `${sessionId}.json`);
  return {
    status: "ok",
    name,
    file,
    sessionId,
    updatedAt: v1UpdatedAt(file, parsed.file),
    fingerprint: fingerprintV1(read.text),
    segments: parsed.file.segments,
    twinFile,
    twin: readTwinSummary(twinFile),
    marker: readClearMarker(home, sessionId),
  };
};

/**
 * Whether a clear marker says this v1 file is cleared history: unless a
 * save after the clear wrote exactly these bytes, it is (fail closed).
 */
export const isClearedV1 = (found: {
  marker: ClearMarker | null;
  fingerprint: string;
}): boolean =>
  found.marker !== null && !isProvenAfterClear(found.marker, found.fingerprint);

export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
