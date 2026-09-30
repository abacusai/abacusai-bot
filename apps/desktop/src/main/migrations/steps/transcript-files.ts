/**
 * Walking `transcripts/` for steps 1 and 4 (spec 00 C.3, C.5): one file at a
 * time, so memory is bounded by the largest single transcript, never by the
 * directory.
 */
import fs from "node:fs";
import path from "node:path";

import {
  parseTranscriptV1,
  type ThreadTwin,
} from "#shared/transcript/thread-file";

import {
  isSafeSessionId,
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
 * The `*.json` regular files of `transcripts/`, sorted. Anything else (an
 * atomic-write temp file, `.DS_Store`, a folder) is not a transcript and is
 * left alone.
 */
export const listTranscriptFiles = (home: string): string[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(transcriptsDir(home), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
};

export type InspectedTranscript =
  | { status: "unsafe"; name: string; file: string }
  | { status: "corrupt"; name: string; file: string }
  | { status: "not-v1"; name: string; file: string }
  | {
      status: "ok";
      name: string;
      file: string;
      sessionId: string;
      updatedAt: string;
      segments: unknown[];
      twinFile: string;
      twin: ThreadTwin;
    };

/** Reads one v1 file and its v2 twin. Never throws for bad content. */
export const inspectTranscript = (
  home: string,
  name: string
): InspectedTranscript => {
  const file = path.join(transcriptsDir(home), name);
  const sessionId = name.slice(0, -".json".length);
  if (!isSafeSessionId(sessionId)) return { status: "unsafe", name, file };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    // Unreadable is as good as corrupt for a migration.
    return { status: "corrupt", name, file };
  }
  const parsed = parseTranscriptV1(text);
  if (parsed.status !== "ok") return { status: parsed.status, name, file };
  const twinFile = path.join(threadsDir(home), `${sessionId}.json`);
  return {
    status: "ok",
    name,
    file,
    sessionId,
    updatedAt: v1UpdatedAt(file, parsed.file),
    segments: parsed.file.segments,
    twinFile,
    twin: readThreadTwin(twinFile),
  };
};

export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
