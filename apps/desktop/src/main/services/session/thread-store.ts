/**
 * `~/.abacusai-bot/threads/<sessionId>.json`, the v2 thread files (spec 00
 * C.3), during the transition while the old renderer still writes v1
 * transcripts:
 *
 * - `readCurrent` (for `ai.hydrate`) returns the v2 thread, converting v1 and
 *   writing the repaired twin when the v2 file is missing, unparseable, or
 *   derived from other v1 bytes (by fingerprint). An `agui` file is returned
 *   as is; a newer build's file or an unreadable one is never replaced.
 * - `writeFromV1` is the dual-write `TranscriptService.write` calls after the
 *   v1 rename. It is deferred and coalesced per thread (`dualWriteDelayMs`),
 *   because the old renderer saves every 750 ms while a chat streams; a read
 *   flushes it first, and a crash before it runs is repaired by the next read.
 * - `writeAgui` is main's AG-UI persistence (the relay).
 * - `markCleared`/`remove` clear a conversation: a clear marker
 *   (`<id>.cleared`, `ClearMarker`) is written first and dropped only once
 *   both files are gone, so no failed or interrupted removal can bring
 *   cleared history back, across restarts too.
 *
 * Every write and removal first asks the migration write block
 * (`isMigrationWriteBlocked`, spec 00 C.1): a file an unresolved migration
 * commit may cover is not touched this launch. The change is kept in memory
 * instead (`overlay`), and reads return it until the app quits.
 *
 * The dual-write and the repair go at the cut-over, when main persists v2
 * from the AG-UI stream. So does the rule that a v1-derived twin whose v1
 * file is gone counts as cleared: step 4 archives such orphans first.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import type { UIMessage } from "#shared/contract";
import {
  decideConversion,
  parseClearMarker,
  parseThreadTwin,
  parseTranscriptV1,
  v1ToThreadFile,
  type ClearMarker,
  type ThreadFileV2,
  type ThreadTwin,
  type V1Meta,
} from "#shared/transcript/thread-file";

import { isMigrationWriteBlocked } from "../../migrations/write-block";
import { abacusBotHome } from "../../paths";

export const THREADS_DIR_NAME = "threads";
export const TRANSCRIPTS_DIR_NAME = "transcripts";

/**
 * The largest v1 transcript converted. Past it, the text, its parse, the v2
 * object and its serialisation would not fit comfortably in main (and V8
 * strings stop at about 512 MB): such a file is kept, listed, and never
 * converted or quarantined.
 */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/** How long the dual-write waits for more saves of the same thread. */
export const DUAL_WRITE_DELAY_MS = 2_000;

// Ids arrive over IPC: a path separator or leading dot would let a caller
// reach outside the folder.
export const isSafeSessionId = (sessionId: string): boolean =>
  typeof sessionId === "string" &&
  /^[A-Za-z0-9._-]+$/.test(sessionId) &&
  !sessionId.startsWith(".");

const isMissingError = (error: unknown): boolean =>
  (error as { code?: unknown })?.code === "ENOENT" ||
  (error as { code?: unknown })?.code === "ENOTDIR";

export type ReadResult =
  | { status: "ok"; text: string }
  | { status: "missing" }
  /** It exists but could not be read: never taken for missing. */
  | { status: "unreadable"; error: string }
  | { status: "tooLarge"; size: number };

/** Reads a file, telling a missing one from one that cannot be read. */
export const readTextChecked = (
  file: string,
  maxBytes = Number.POSITIVE_INFINITY
): ReadResult => {
  try {
    if (Number.isFinite(maxBytes)) {
      const { size } = fs.statSync(file);
      if (size > maxBytes) return { status: "tooLarge", size };
    }
    return { status: "ok", text: fs.readFileSync(file, "utf8") };
  } catch (error) {
    return isMissingError(error)
      ? { status: "missing" }
      : { status: "unreadable", error: String(error) };
  }
};

/** A v1 file's fingerprint: a hash of its exact text. */
export const fingerprintV1 = (text: string): string =>
  createHash("sha256").update(text).digest("base64url");

/** The twin at `file`, as the conversion rules see it. */
export const readThreadTwin = (file: string): ThreadTwin => {
  const read = readTextChecked(file);
  if (read.status === "ok") return parseThreadTwin(read.text);
  return read.status === "missing"
    ? { status: "missing" }
    : { status: "unreadable" };
};

/**
 * The source kind in a thread file's first 4 KB, where both writers put it
 * (`JSON.stringify` keeps `source` before `messages`), so the dual-write
 * learns it without parsing a large file. Null when it is not there.
 */
export const peekSourceKind = (file: string): string | null => {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, head, 0, head.length, 0);
    const match = /"source":\{"kind":"([^"]+)"/.exec(
      head.subarray(0, bytes).toString("utf8")
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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

export const clearMarkerPath = (threadsDir: string, sessionId: string) =>
  path.join(threadsDir, `${sessionId}.cleared`);

export interface ThreadStoreOptions {
  /** Defaults to `abacusBotHome()`, read on every call (tests set the env). */
  home?: () => string;
  log?: (message: string) => void;
  /** Defaults to the migration runner's `isMigrationWriteBlocked`. */
  isWriteBlocked?: (file: string) => boolean;
  /** 0 writes at once (tests). */
  dualWriteDelayMs?: number;
  /** Test seam for write failures. */
  writeFile?: (file: string, text: string) => void;
  /** Defaults to `MAX_TRANSCRIPT_BYTES` (tests lower it). */
  maxTranscriptBytes?: number;
  /**
   * The cut-over build sets this once step 4 has archived `transcripts/`:
   * a v1-derived twin is then served without its v1 file.
   */
  v1Archived?: boolean;
}

type V1Read =
  | { status: "ok"; meta: Required<V1Meta>; segments: unknown[] }
  | { status: "missing" | "unreadable" | "tooLarge" | "invalid" };

interface PendingDualWrite {
  timer: ReturnType<typeof setTimeout> | null;
  v1: { updatedAt: string; segments: readonly unknown[]; text?: string };
}

export class ThreadStore {
  private readonly home: () => string;
  private readonly log: (message: string) => void;
  private readonly isWriteBlocked: (file: string) => boolean;
  private readonly dualWriteDelayMs: number;
  private readonly writeFile: (file: string, text: string) => void;
  private readonly maxTranscriptBytes: number;
  private readonly v1Archived: boolean;
  /**
   * What this store last wrote per thread (size, mtime and source kind), so
   * the dual-write does not re-read a large file it wrote itself just to
   * learn its kind.
   */
  private readonly written = new Map<
    string,
    { size: number; mtimeMs: number; kind: "agui" | "v1" }
  >();
  /** Changes held in memory because the file is write-blocked (null: cleared). */
  private readonly overlay = new Map<string, ThreadFileV2 | null>();
  private readonly pending = new Map<string, PendingDualWrite>();
  private readonly blockedLogged = new Set<string>();

  constructor(options: ThreadStoreOptions = {}) {
    this.home = options.home ?? abacusBotHome;
    this.log =
      options.log ?? ((message) => console.error(`[threads] ${message}`));
    this.isWriteBlocked = options.isWriteBlocked ?? isMigrationWriteBlocked;
    this.dualWriteDelayMs = options.dualWriteDelayMs ?? DUAL_WRITE_DELAY_MS;
    this.writeFile = options.writeFile ?? writeFileAtomicSync;
    this.maxTranscriptBytes =
      options.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES;
    this.v1Archived = options.v1Archived ?? false;
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

  private markerPath(sessionId: string): string {
    return clearMarkerPath(path.join(this.home(), THREADS_DIR_NAME), sessionId);
  }

  /** `ai.hydrate`'s messages (`ThreadReader`). */
  async readCurrent(sessionId: string): Promise<UIMessage[]> {
    return this.readCurrentFile(sessionId)?.messages ?? [];
  }

  /**
   * The current v2 thread, repaired from v1 when stale. Null when neither
   * file holds a thread, when the conversation was cleared (a clear marker
   * no later write superseded), and for a v1-derived file whose v1 file is
   * gone.
   */
  readCurrentFile(sessionId: string): ThreadFileV2 | null {
    const threadFile = this.threadPath(sessionId);
    const transcriptFile = this.transcriptPath(sessionId);
    if (threadFile == null || transcriptFile == null) return null;
    this.flush(sessionId);
    if (this.overlay.has(sessionId)) return this.overlay.get(sessionId) ?? null;

    const marker = this.readMarker(sessionId);
    const twin = readThreadTwin(threadFile);
    const v1 = this.readV1(transcriptFile);

    if (marker !== null) {
      const postClear =
        twin.status === "ok" && twin.source.afterClear === marker.token;
      if (!postClear) {
        // Only a v1 file whose bytes changed since the clear is new history.
        if (v1.status === "ok" && v1.meta.fingerprint !== marker.v1Fingerprint)
          return this.repair(sessionId, threadFile, v1, marker.token);
        return null;
      }
    }

    if (twin.status === "ok" && twin.source.kind === "agui") return twin.file;
    if (twin.status === "foreign" || twin.status === "unreadable") {
      // Never replaced: served from v1 in memory when possible.
      this.log(`${sessionId}: thread file is ${twin.status}; left as is`);
      return v1.status === "ok"
        ? v1ToThreadFile({
            threadId: sessionId,
            ...v1.meta,
            segments: v1.segments,
          })
        : null;
    }
    switch (v1.status) {
      case "missing":
        // Transition: v1 is the source of truth, so a derived twin without
        // it was cleared. At the cut-over (after step 4 archived v1 files
        // and orphaned twins), the twin stands on its own.
        return this.v1Archived && twin.status === "ok" ? twin.file : null;
      case "invalid":
        return null;
      case "unreadable":
      case "tooLarge":
        // Nothing to convert from: the twin as it is, never repaired.
        this.log(`${sessionId}: transcript is ${v1.status}; not converted`);
        return twin.status === "ok" ? twin.file : null;
      case "ok": {
        const decision = decideConversion(v1.meta, twin);
        if (decision.action === "skip" && twin.status === "ok")
          return twin.file;
        return this.repair(sessionId, threadFile, v1, marker?.token);
      }
    }
  }

  /**
   * The transition dual-write, after the v1 rename. Never over an `agui`
   * file, a newer build's file or one that cannot be read. Deferred and
   * coalesced; with no delay it runs at once and throws on a failed write
   * (the caller isolates it).
   */
  writeFromV1(
    sessionId: string,
    v1: { updatedAt: string; segments: readonly unknown[]; text?: string }
  ): void {
    if (this.threadPath(sessionId) == null) return;
    if (this.dualWriteDelayMs <= 0) {
      this.dualWrite(sessionId, v1);
      return;
    }
    const existing = this.pending.get(sessionId);
    if (existing?.timer != null) clearTimeout(existing.timer);
    const entry: PendingDualWrite = { timer: null, v1 };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.flush(sessionId);
    }, this.dualWriteDelayMs);
    entry.timer.unref?.();
    this.pending.set(sessionId, entry);
  }

  /** Runs a deferred dual-write now (all of them without an id). */
  flush(sessionId?: string): void {
    const ids =
      sessionId === undefined ? [...this.pending.keys()] : [sessionId];
    for (const id of ids) {
      const entry = this.pending.get(id);
      if (entry === undefined) continue;
      this.pending.delete(id);
      if (entry.timer != null) clearTimeout(entry.timer);
      try {
        this.dualWrite(id, entry.v1);
      } catch (error) {
        // The next read repairs it.
        this.log(`dual-write of ${id} failed: ${String(error)}`);
      }
    }
  }

  private dualWrite(
    sessionId: string,
    v1: { updatedAt: string; segments: readonly unknown[]; text?: string }
  ): void {
    const threadFile = this.threadPath(sessionId);
    if (threadFile == null) return;
    const own = this.ownWriteKind(sessionId, threadFile);
    // The relay's own `agui` write is never replaced by v1-derived history.
    if (own === "agui") return;
    if (own == null && peekSourceKind(threadFile) !== "transcript-v1") {
      const twin = readThreadTwin(threadFile);
      if (twin.status === "ok" && twin.source.kind === "agui") return;
      if (twin.status === "foreign" || twin.status === "unreadable") {
        this.log(`${sessionId}: thread file is ${twin.status}; not replaced`);
        return;
      }
    }
    const thread = v1ToThreadFile({
      threadId: sessionId,
      updatedAt: v1.updatedAt,
      segments: v1.segments,
      ...(v1.text !== undefined && { fingerprint: fingerprintV1(v1.text) }),
      ...this.afterClear(sessionId),
    });
    this.persist(sessionId, threadFile, thread, "dual-write", true);
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
    const pending = this.pending.get(sessionId);
    if (pending?.timer != null) clearTimeout(pending.timer);
    this.pending.delete(sessionId);
    const file: ThreadFileV2 = {
      version: 2,
      threadId: sessionId,
      updatedAt: new Date().toISOString(),
      source: {
        kind: "agui",
        ...(thread.migratedFrom != null && {
          migratedFrom: thread.migratedFrom,
        }),
        ...this.afterClear(sessionId),
      },
      messages: thread.messages,
      runs: thread.runs,
    };
    this.persist(sessionId, threadFile, file, "agui", true);
  }

  /**
   * Writes the clear marker, holding the v1 file's fingerprint if it still
   * exists. `TranscriptService.remove` calls it before removing anything.
   */
  markCleared(sessionId: string): void {
    const transcriptFile = this.transcriptPath(sessionId);
    if (transcriptFile == null) return;
    const pending = this.pending.get(sessionId);
    if (pending?.timer != null) clearTimeout(pending.timer);
    this.pending.delete(sessionId);
    const v1 = readTextChecked(transcriptFile, this.maxTranscriptBytes);
    const marker: ClearMarker = {
      version: 1,
      token: randomUUID(),
      clearedAt: new Date().toISOString(),
      ...(v1.status === "ok" && { v1Fingerprint: fingerprintV1(v1.text) }),
    };
    const file = this.markerPath(sessionId);
    if (this.blocked(sessionId, file)) {
      this.overlay.set(sessionId, null);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.writeFile(file, JSON.stringify(marker));
    } catch (error) {
      // Still cleared for this launch.
      this.overlay.set(sessionId, null);
      this.log(`clear marker for ${sessionId} failed: ${String(error)}`);
    }
  }

  /**
   * Clears the thread: marker, then the v2 file, then the marker again once
   * neither file is left. A blocked or failed removal leaves the marker, so
   * the thread stays cleared.
   */
  remove(sessionId: string): void {
    const threadFile = this.threadPath(sessionId);
    const transcriptFile = this.transcriptPath(sessionId);
    if (threadFile == null || transcriptFile == null) return;
    this.markCleared(sessionId);
    this.written.delete(sessionId);
    if (this.blocked(sessionId, threadFile)) {
      this.overlay.set(sessionId, null);
      return;
    }
    fs.rmSync(threadFile, { force: true });
    if (fs.existsSync(transcriptFile) || fs.existsSync(threadFile)) return;
    const marker = this.markerPath(sessionId);
    if (this.blocked(sessionId, marker)) return;
    fs.rmSync(marker, { force: true });
    if (this.overlay.get(sessionId) === null) this.overlay.delete(sessionId);
  }

  private repair(
    sessionId: string,
    threadFile: string,
    v1: Extract<V1Read, { status: "ok" }>,
    afterClear: string | undefined
  ): ThreadFileV2 {
    const thread = v1ToThreadFile({
      threadId: sessionId,
      ...v1.meta,
      segments: v1.segments,
      ...(afterClear !== undefined && { afterClear }),
    });
    this.persist(sessionId, threadFile, thread, "repair");
    return thread;
  }

  private readMarker(sessionId: string): ClearMarker | null {
    const read = readTextChecked(this.markerPath(sessionId));
    if (read.status === "missing") return null;
    // An unreadable or damaged marker still means cleared; no token matches.
    return (
      (read.status === "ok" ? parseClearMarker(read.text) : null) ?? {
        version: 1,
        token: "",
        clearedAt: "",
      }
    );
  }

  private readV1(file: string): V1Read {
    const read = readTextChecked(file, this.maxTranscriptBytes);
    if (read.status !== "ok") return { status: read.status };
    const parsed = parseTranscriptV1(read.text);
    if (parsed.status !== "ok") return { status: "invalid" };
    return {
      status: "ok",
      meta: {
        updatedAt: v1UpdatedAt(file, parsed.file),
        fingerprint: fingerprintV1(read.text),
      },
      segments: parsed.file.segments,
    };
  }

  /** The current marker's token, for a write made after a clear. */
  private afterClear(sessionId: string): { afterClear?: string } {
    const marker = this.readMarker(sessionId);
    return marker === null || marker.token === ""
      ? {}
      : { afterClear: marker.token };
  }

  private blocked(sessionId: string, file: string): boolean {
    if (!this.isWriteBlocked(file)) return false;
    if (!this.blockedLogged.has(file)) {
      this.blockedLogged.add(file);
      this.log(
        `${sessionId}: ${path.basename(file)} is held by an unresolved migration; changes stay in memory this launch`
      );
    }
    return true;
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

  private persist(
    sessionId: string,
    file: string,
    thread: ThreadFileV2,
    reason: "repair" | "dual-write" | "agui",
    rethrow = false
  ): void {
    if (this.blocked(sessionId, file)) {
      this.overlay.set(sessionId, thread);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.writeFile(file, JSON.stringify(thread));
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
      return;
    }
    // Written after the clear, and carrying its token: the marker is done.
    if (thread.source.afterClear !== undefined) {
      const marker = this.markerPath(sessionId);
      if (!this.blocked(sessionId, marker))
        try {
          fs.rmSync(marker, { force: true });
        } catch (error) {
          this.log(`clear marker of ${sessionId}: ${String(error)}`);
        }
    }
  }
}
