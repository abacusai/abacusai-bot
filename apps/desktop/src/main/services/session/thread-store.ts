/**
 * `~/.abacusai-bot/threads/<sessionId>.json`, the v2 thread files (spec 00
 * C.3), during the transition while the old renderer still writes v1
 * transcripts:
 *
 * - `readCurrent` (for `ai.hydrate`) returns the v2 thread, converting v1 and
 *   writing the repaired twin when the v2 file is missing, unparseable, or
 *   v1-derived and older than v1. An `agui` file is returned as is.
 * - `writeFromV1` is the dual-write `TranscriptService.write` calls after the
 *   v1 rename.
 * - `remove` is called from `TranscriptService.remove`, the one path used by
 *   conversation reset and session and workspace deletion, so no v2 file
 *   outlives its v1 file.
 *
 * The dual-write and the repair go at the cut-over, when main persists v2
 * from the AG-UI stream.
 */
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import type { UIMessage } from "#shared/contract";
import {
  decideConversion,
  parseThreadTwin,
  parseTranscriptV1,
  v1ToThreadFile,
  type ThreadFileV2,
  type ThreadTwin,
} from "#shared/transcript/thread-file";

import { abacusBotHome } from "../../paths";

export const THREADS_DIR_NAME = "threads";
export const TRANSCRIPTS_DIR_NAME = "transcripts";

// Ids arrive over IPC: a path separator or leading dot would let a caller
// reach outside the folder.
export const isSafeSessionId = (sessionId: string): boolean =>
  typeof sessionId === "string" &&
  /^[A-Za-z0-9._-]+$/.test(sessionId) &&
  !sessionId.startsWith(".");

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** The twin at `file`, as the conversion rules see it. */
export const readThreadTwin = (file: string): ThreadTwin => {
  const text = readText(file);
  return text === null ? { status: "missing" } : parseThreadTwin(text);
};

/** A v1 file's `updatedAt`, or its mtime when the field is missing. */
export const v1UpdatedAt = (
  file: string,
  parsed: { updatedAt?: string }
): string => {
  if (parsed.updatedAt !== undefined) return parsed.updatedAt;
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
};

export interface ThreadStoreOptions {
  /** Defaults to `abacusBotHome()`, read on every call (tests set the env). */
  home?: () => string;
  log?: (message: string) => void;
}

export class ThreadStore {
  private readonly home: () => string;
  private readonly log: (message: string) => void;
  /**
   * What this store last wrote per thread (size, mtime and source kind), so
   * the dual-write does not re-read a large file it wrote itself just to
   * learn its kind.
   */
  private readonly written = new Map<
    string,
    { size: number; mtimeMs: number; kind: "agui" | "v1" }
  >();

  constructor(options: ThreadStoreOptions = {}) {
    this.home = options.home ?? abacusBotHome;
    this.log =
      options.log ?? ((message) => console.error(`[threads] ${message}`));
  }

  threadPath(sessionId: string): string | null {
    return isSafeSessionId(sessionId)
      ? path.join(this.home(), THREADS_DIR_NAME, `${sessionId}.json`)
      : null;
  }

  transcriptPath(sessionId: string): string | null {
    return isSafeSessionId(sessionId)
      ? path.join(this.home(), TRANSCRIPTS_DIR_NAME, `${sessionId}.json`)
      : null;
  }

  /** `ai.hydrate`'s messages (`ThreadReader`). */
  async readCurrent(sessionId: string): Promise<UIMessage[]> {
    return this.readCurrentFile(sessionId)?.messages ?? [];
  }

  /**
   * The current v2 thread, repaired from v1 when stale. Null when neither
   * file holds a thread, and for a v1-derived file whose v1 file is gone:
   * the conversation was cleared, and a failed v2 removal must not bring it
   * back.
   */
  readCurrentFile(sessionId: string): ThreadFileV2 | null {
    const threadFile = this.threadPath(sessionId);
    const transcriptFile = this.transcriptPath(sessionId);
    if (threadFile == null || transcriptFile == null) return null;

    const twin = readThreadTwin(threadFile);
    if (twin.status === "ok" && twin.source.kind === "agui") return twin.file;

    const text = readText(transcriptFile);
    const v1 = text === null ? null : parseTranscriptV1(text);
    if (v1 == null || v1.status !== "ok") return null;

    const updatedAt = v1UpdatedAt(transcriptFile, v1.file);
    const decision = decideConversion(updatedAt, twin);
    if (decision.action === "skip" && twin.status === "ok") return twin.file;

    const thread = v1ToThreadFile({
      threadId: sessionId,
      updatedAt,
      segments: v1.file.segments,
    });
    this.write(sessionId, threadFile, thread, "repair");
    return thread;
  }

  /**
   * The transition dual-write, after the v1 rename. Never over an `agui`
   * file. Throws on a failed write; the caller isolates it.
   */
  writeFromV1(
    sessionId: string,
    v1: { updatedAt: string; segments: readonly unknown[] }
  ): void {
    const threadFile = this.threadPath(sessionId);
    if (threadFile == null) return;
    const own = this.ownWriteKind(sessionId, threadFile);
    // The relay's own `agui` write is never replaced by v1-derived history.
    if (own === "agui") return;
    if (own == null) {
      const twin = readThreadTwin(threadFile);
      if (twin.status === "ok" && twin.source.kind === "agui") return;
    }
    const thread = v1ToThreadFile({
      threadId: sessionId,
      updatedAt: v1.updatedAt,
      segments: v1.segments,
    });
    this.write(sessionId, threadFile, thread, "dual-write", true);
  }

  /**
   * Main's AG-UI persistence (spec 02 §14.7): the relay's transcript and run
   * outcomes at a terminal, as a `source.kind: "agui"` file, which the
   * dual-write and the repair never overwrite. `migratedFrom` records the v1
   * file the history started from, if any. Throws on a failed write.
   */
  writeAgui(
    sessionId: string,
    thread: {
      messages: UIMessage[];
      runs: unknown[];
      migratedFrom?: { updatedAt: string };
    }
  ): void {
    const threadFile = this.threadPath(sessionId);
    if (threadFile == null) return;
    const file: ThreadFileV2 = {
      version: 2,
      threadId: sessionId,
      updatedAt: new Date().toISOString(),
      source: {
        kind: "agui",
        ...(thread.migratedFrom != null && {
          migratedFrom: thread.migratedFrom,
        }),
      },
      messages: thread.messages,
      runs: thread.runs,
    };
    this.write(sessionId, threadFile, file, "agui", true);
  }

  remove(sessionId: string): void {
    const threadFile = this.threadPath(sessionId);
    if (threadFile == null) return;
    this.written.delete(sessionId);
    fs.rmSync(threadFile, { force: true });
  }

  /** The kind of this store's own last write, if the file is still it. */
  private ownWriteKind(sessionId: string, file: string): "agui" | "v1" | null {
    const known = this.written.get(sessionId);
    if (known === undefined) return null;
    try {
      const stat = fs.statSync(file);
      return stat.size === known.size && stat.mtimeMs === known.mtimeMs
        ? known.kind
        : null;
    } catch {
      return null;
    }
  }

  private write(
    sessionId: string,
    file: string,
    thread: ThreadFileV2,
    reason: "repair" | "dual-write" | "agui",
    rethrow = false
  ): void {
    try {
      writeFileAtomicSync(file, JSON.stringify(thread));
      const stat = fs.statSync(file);
      this.written.set(sessionId, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        kind: reason === "agui" ? "agui" : "v1",
      });
    } catch (error) {
      this.written.delete(sessionId);
      if (rethrow) throw error;
      // The repaired thread is still returned; the next read tries again.
      this.log(`${reason} of ${sessionId} failed: ${String(error)}`);
    }
  }
}
