/**
 * `~/.abacusai-bot/threads/<sessionId>.json`, the v2 thread files (spec 00
 * C.3), during the transition while the old renderer still writes v1
 * transcripts:
 *
 * - `readCurrent` (for `ai.hydrate`) returns the v2 thread, converting v1 and
 *   writing the repaired twin when the v2 file is missing, unparseable, or
 *   derived from other v1 bytes (by fingerprint). An `agui` file is returned
 *   as is.
 * - `writeAgui` is main's AG-UI persistence (the relay).
 * - `markCleared`/`remove` clear a conversation: a clear marker
 *   (`<id>.cleared`, `ClearMarker`) is written first and dropped only once
 *   both files are gone, so no failed or interrupted removal can bring
 *   cleared history back, across restarts too. A v1 file counts as new
 *   history after a clear only when a save proved it (`noteSave`).
 *
 * Ownership comes before every write: a newer build's file (`foreign`) or
 * one that cannot be read is never replaced, by the repair
 * or `writeAgui` (which throws, so the relay keeps its history in memory and
 * logs the refusal). Hydration then serves v1 converted in memory.
 *
 * Every write and removal goes through `HeldFiles`: a file an unresolved
 * migration commit may cover (`isMigrationWriteBlocked`, spec 00 C.1) is not
 * touched; the change is journalled under `threads/.pending/` and replayed
 * once the block lifts, and reads see it meanwhile.
 *
 * The dual-write and the repair go at the cut-over, when main persists v2
 * from the AG-UI stream. So does the rule that a v1-derived twin whose v1
 * file is gone counts as cleared: step 4 records the files it archives
 * (`threads/.archive-index.json`), and those twins are served.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import type { UIMessage } from "@abacus-ai/contract/contract";
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
} from "@abacus-ai/contract/transcript/thread-file";

import { isMigrationWriteBlocked } from "../../migrations/write-block";
import { abacusBotHome } from "../../paths";
import { HeldFiles } from "./held-files";
import { streamTranscriptV1 } from "./stream-v1";

export const THREADS_DIR_NAME = "threads";
export const TRANSCRIPTS_DIR_NAME = "transcripts";
/** Step 4's durable list of the v1 files it archived (see `ArchiveIndex`). */
export const ARCHIVE_INDEX_NAME = ".archive-index.json";

/**
 * The largest v1 transcript converted. Past it, the text, its parse, the v2
 * object and its serialisation would not fit comfortably in main (and V8
 * strings stop at about 512 MB): such a file is kept, listed, and never
 * converted or quarantined.
 */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * The largest v1 transcript read at all, through the streaming reader
 * (`stream-v1.ts`) and converted in memory only, never persisted as a twin.
 * Past it, reads answer with a `too-large` notice (cut-over review r2 #8).
 */
export const MAX_STREAMED_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

/** Why a thread shows no history although its v1 file exists. */
export type ThreadNotice = { kind: "too-large"; size: number; limit: number };

/** How long the dual-write waits for more saves of the same thread. */

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

const twinOf = (read: ReadResult): ThreadTwin => {
  if (read.status === "ok") return parseThreadTwin(read.text);
  return read.status === "missing"
    ? { status: "missing" }
    : { status: "unreadable" };
};

/** The twin at `file`, as the conversion rules see it. */
export const readThreadTwin = (file: string): ThreadTwin =>
  twinOf(readTextChecked(file));

/**
 * The exact header this build's v1-derived writer produces
 * (`v1ToThreadFile` keys in order, compact `JSON.stringify`): the top-level
 * `source` is recognised only in that position, never a nested one.
 */
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const DERIVED_HEADER = new RegExp(
  String.raw`^\{"version":2,"threadId":${JSON_STRING},"updatedAt":${JSON_STRING},"source":\{"kind":"transcript-v1","updatedAt":${JSON_STRING},"segments":\d+[,}]`
);

/**
 * True when a thread file's first 4 KB say it is a version-2 v1-derived
 * file, as this build writes it (`JSON.stringify` keeps `version` first and
 * `source` before `messages`), so the dual-write can replace it without
 * parsing a large file. Anything else takes the full parse.
 */
export const peeksAsDerivedV2 = (file: string): boolean => {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, head, 0, head.length, 0);
    const text = head.subarray(0, bytes).toString("utf8");
    return DERIVED_HEADER.test(text);
  } catch {
    return false;
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

/** A marker that cannot be read or parsed still means cleared. */
const DAMAGED_MARKER: ClearMarker = { version: 1, token: "", clearedAt: "" };

export const parseMarkerRead = (read: ReadResult): ClearMarker | null => {
  if (read.status === "missing") return null;
  return (
    (read.status === "ok" ? parseClearMarker(read.text) : null) ??
    DAMAGED_MARKER
  );
};

/**
 * Whether a v1 file holds history saved after its thread was cleared: only
 * a save proves it (`savedAfterClear`). Fails closed.
 */
export const isProvenAfterClear = (
  marker: ClearMarker,
  fingerprint: string
): boolean => marker.savedAfterClear === fingerprint;

/**
 * `threads/.archive-index.json`: every v1 file step 4 archived, with the
 * fingerprint it had, written in the same commit as the removals. A
 * v1-derived twin whose v1 file is listed here was archived, not cleared.
 */
export interface ArchiveIndex {
  version: 1;
  archived: Record<string, { fingerprint: string; updatedAt: string }>;
}

const isArchiveIndex = (value: unknown): value is ArchiveIndex => {
  const index = value as ArchiveIndex | null;
  if (
    typeof index !== "object" ||
    index === null ||
    index.version !== 1 ||
    typeof index.archived !== "object" ||
    index.archived === null ||
    Array.isArray(index.archived)
  )
    return false;
  return Object.values(index.archived).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.fingerprint === "string" &&
      typeof entry.updatedAt === "string"
  );
};

/**
 * The archive index; empty only when the file does not exist. A file that
 * cannot be read or validated throws: step 4 must not guess which twins
 * it archived (it would take them for orphans).
 */
export const readArchiveIndexStrict = (threadsDir: string): ArchiveIndex => {
  const file = path.join(threadsDir, ARCHIVE_INDEX_NAME);
  const read = readTextChecked(file);
  if (read.status === "missing") return { version: 1, archived: {} };
  if (read.status !== "ok")
    throw new Error(`cannot read ${file}: ${read.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  if (!isArchiveIndex(parsed)) throw new Error(`${file} is not an index`);
  return parsed;
};

/** For reads: a damaged index serves nothing from it (nothing is removed). */
export const readArchiveIndex = (
  threadsDir: string,
  log: (message: string) => void = console.error
): ArchiveIndex => {
  try {
    return readArchiveIndexStrict(threadsDir);
  } catch (error) {
    log(`archive index unavailable: ${String(error)}`);
    return { version: 1, archived: {} };
  }
};

/** Thrown by `writeAgui` for a thread file it must not replace. */
export class ThreadFileProtectedError extends Error {
  constructor(
    readonly threadId: string,
    readonly reason: "foreign" | "unreadable"
  ) {
    super(
      `${threadId}: the thread file is ${reason}; not replaced (the history stays in memory)`
    );
    this.name = "ThreadFileProtectedError";
  }
}

export interface ThreadStoreOptions {
  /** Defaults to `abacusBotHome()`, read on every call (tests set the env). */
  home?: () => string;
  log?: (message: string) => void;
  /** Defaults to the migration runner's `isMigrationWriteBlocked`. */
  isWriteBlocked?: (file: string) => boolean;
  /** 0 writes at once (tests). */
  /** Test seam for write failures. */
  writeFile?: (file: string, text: string) => void;
  /** Defaults to `MAX_TRANSCRIPT_BYTES` (tests lower it). */
  maxTranscriptBytes?: number;
  /** Defaults to `MAX_STREAMED_TRANSCRIPT_BYTES` (tests lower it). */
  maxStreamedBytes?: number;
  /**
   * The cut-over build sets this once step 4 has archived `transcripts/`:
   * a v1-derived twin is then served without its v1 file.
   */
}

type V1Read =
  | {
      status: "ok";
      meta: Required<V1Meta>;
      segments: unknown[];
      /** Over `maxTranscriptBytes`: converted in memory, never persisted. */
      large: boolean;
    }
  | { status: "tooLarge"; size: number }
  | { status: "missing" | "unreadable" | "invalid" };

type Ownership =
  | "missing"
  | "corrupt"
  | "derived"
  | "agui"
  | "foreign"
  | "unreadable";

export class ThreadStore {
  private readonly home: () => string;
  private readonly log: (message: string) => void;
  private readonly maxTranscriptBytes: number;
  private readonly maxStreamedBytes: number;
  /** Writes and removals, journalled while a migration holds the file. */
  readonly held: HeldFiles;
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
    this.maxTranscriptBytes =
      options.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES;
    this.maxStreamedBytes =
      options.maxStreamedBytes ?? MAX_STREAMED_TRANSCRIPT_BYTES;
    this.held = new HeldFiles({
      dir: () => path.join(this.home(), THREADS_DIR_NAME, ".pending"),
      isWriteBlocked: options.isWriteBlocked ?? isMigrationWriteBlocked,
      writeFile: options.writeFile ?? writeFileAtomicSync,
      log: this.log,
    });
  }

  /**
   * Applies every journalled write whose destination is no longer held, for
   * every thread, opened or not. Main calls it once at startup, right after
   * the migration runner set this launch's write blocks: a thread saved
   * while a previous launch's recovery was unresolved, and never opened
   * again, still reaches its file.
   */
  replayHeld(): number {
    try {
      const applied = this.held.replayAll();
      if (applied > 0) this.log(`replayed ${applied} held thread write(s)`);
      return applied;
    } catch (error) {
      this.log(`replaying held thread writes failed: ${String(error)}`);
      return 0;
    }
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

  /** Debug sync reads only an existing AG-UI twin, without converting v1. */
  readAguiFile(sessionId: string): ThreadFileV2 | null {
    const file = this.threadPath(sessionId);
    if (file == null) return null;
    const twin = twinOf(this.held.read(file));
    if (twin.status !== "ok" || twin.source.kind !== "agui") return null;
    const marker = this.readMarker(sessionId);
    if (
      marker != null &&
      (marker.token === "" || twin.source.afterClear !== marker.token)
    )
      return null;
    return twin.file;
  }

  /** `ai.hydrate`'s messages (`ThreadReader`). */
  async readCurrent(sessionId: string): Promise<UIMessage[]> {
    return this.readCurrentFile(sessionId)?.messages ?? [];
  }

  /**
   * The current v2 thread, repaired from v1 when stale. Null when neither
   * file holds a thread, when the conversation was cleared (a clear marker
   * no later write superseded), and for a v1-derived file whose v1 file is
   * gone (unless step 4 archived it).
   */
  readCurrentFile(sessionId: string): ThreadFileV2 | null {
    return this.readCurrentWithNotice(sessionId).file;
  }

  /**
   * `readCurrentFile`, plus why there is no history when a v1 file exists
   * but is too large to read at all (for the relay to surface).
   */
  readCurrentWithNotice(sessionId: string): {
    file: ThreadFileV2 | null;
    notice?: ThreadNotice;
  } {
    const threadFile = this.threadPath(sessionId);
    const transcriptFile = this.transcriptPath(sessionId);
    if (threadFile == null || transcriptFile == null) return { file: null };
    const marker = this.readMarker(sessionId);
    const v1 = this.readV1(transcriptFile);
    const file = this.current(sessionId, threadFile, marker, v1);
    return file === null && marker === null && v1.status === "tooLarge"
      ? {
          file,
          notice: {
            kind: "too-large",
            size: v1.size,
            limit: this.maxStreamedBytes,
          },
        }
      : { file };
  }

  private current(
    sessionId: string,
    threadFile: string,
    marker: ClearMarker | null,
    v1: V1Read
  ): ThreadFileV2 | null {
    const twin = twinOf(this.held.read(threadFile));
    const proven =
      marker !== null &&
      v1.status === "ok" &&
      isProvenAfterClear(marker, v1.meta.fingerprint);

    if (twin.status === "foreign" || twin.status === "unreadable") {
      // Never replaced, not even by a repair after a clear: served from v1
      // in memory, when v1 is history.
      this.log(`${sessionId}: thread file is ${twin.status}; left as is`);
      if (v1.status !== "ok" || (marker !== null && !proven)) return null;
      return this.convert(sessionId, v1, marker?.token);
    }

    if (marker !== null) {
      const postClear =
        marker.token !== "" &&
        twin.status === "ok" &&
        twin.source.afterClear === marker.token;
      if (!postClear)
        return proven
          ? this.repair(sessionId, threadFile, v1, marker.token)
          : null;
    }

    if (twin.status === "ok" && twin.source.kind === "agui") return twin.file;
    switch (v1.status) {
      case "missing":
        // Transition: v1 is the source of truth, so a derived twin without
        // it was cleared, unless step 4 archived that v1 file (cut-over).
        return twin.status === "ok" && this.archived(sessionId, twin)
          ? twin.file
          : null;
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
   * Records that the old renderer saved `text` as the v1 file: while the
   * thread has a clear marker, that save is the proof that the v1 file is
   * new history (`savedAfterClear`).
   */
  noteSave(sessionId: string, text: string): void {
    if (!isSafeSessionId(sessionId)) return;
    const marker = this.readMarker(sessionId);
    if (marker === null) return;
    const next: ClearMarker = {
      ...marker,
      token: marker.token === "" ? randomUUID() : marker.token,
      savedAfterClear: fingerprintV1(text),
    };
    try {
      this.held.write(this.markerPath(sessionId), JSON.stringify(next));
    } catch (error) {
      this.log(`clear marker of ${sessionId}: ${String(error)}`);
    }
  }

  /**
   * Main's AG-UI persistence (spec 02 §14.7): the relay's transcript and run
   * outcomes at a terminal, as a `source.kind: "agui"` file, which the
   * dual-write and the repair never overwrite. `migratedFrom` records the v1
   * file the history started from, if any. Throws on a failed write, and
   * `ThreadFileProtectedError` for a newer build's file or one that cannot
   * be read.
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
    const owner = this.ownership(sessionId, threadFile);
    if (owner === "foreign" || owner === "unreadable")
      throw new ThreadFileProtectedError(sessionId, owner);
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
    // Held in memory (write-blocked) or on disk: readers now see it.
    for (const listener of this.aguiListeners) {
      try {
        listener(sessionId);
      } catch (error) {
        this.log(`an AG-UI persist listener threw: ${String(error)}`);
      }
    }
  }

  private readonly aguiListeners = new Set<(sessionId: string) => void>();

  /**
   * After every `writeAgui` (spec 03 §24.12 c): what `TranscriptService`'s
   * `onPersist` is for v1 saves (debug sync, bot previews). Returns the
   * removal.
   */
  onAguiPersist(listener: (sessionId: string) => void): () => void {
    this.aguiListeners.add(listener);
    return () => this.aguiListeners.delete(listener);
  }

  /**
   * Writes the clear marker, holding the v1 file's fingerprint if it can be
   * read. `TranscriptService.remove` calls it before removing anything.
   */
  markCleared(sessionId: string): void {
    const transcriptFile = this.transcriptPath(sessionId);
    if (transcriptFile == null) return;
    const v1 = this.held.read(transcriptFile, this.maxTranscriptBytes);
    const marker: ClearMarker = {
      version: 1,
      token: randomUUID(),
      clearedAt: new Date().toISOString(),
      ...(v1.status === "ok" && { v1Fingerprint: fingerprintV1(v1.text) }),
    };
    try {
      this.held.write(this.markerPath(sessionId), JSON.stringify(marker));
    } catch (error) {
      this.log(`clear marker for ${sessionId} failed: ${String(error)}`);
    }
  }

  /**
   * Clears the thread: marker, then the v2 file, then the marker again once
   * neither file is left. A held or failed removal leaves the marker, so
   * the thread stays cleared.
   */
  remove(sessionId: string): void {
    const threadFile = this.threadPath(sessionId);
    const transcriptFile = this.transcriptPath(sessionId);
    if (threadFile == null || transcriptFile == null) return;
    this.markCleared(sessionId);
    this.written.delete(sessionId);
    this.held.remove(threadFile);
    if (this.held.exists(transcriptFile) || this.held.exists(threadFile))
      return;
    this.held.remove(this.markerPath(sessionId));
  }

  /** Who owns the thread file, as the writers must respect it. */
  private ownership(sessionId: string, threadFile: string): Ownership {
    const pending = this.held.pending(threadFile);
    if (pending === null) {
      const own = this.ownWriteKind(sessionId, threadFile);
      if (own === "agui") return "agui";
      if (own === "v1" || peeksAsDerivedV2(threadFile)) return "derived";
    }
    const twin = twinOf(this.held.read(threadFile));
    switch (twin.status) {
      case "ok":
        return twin.source.kind === "agui" ? "agui" : "derived";
      default:
        return twin.status;
    }
  }

  private archived(
    sessionId: string,
    twin: Extract<ThreadTwin, { status: "ok" }>
  ): boolean {
    if (twin.source.kind !== "transcript-v1") return false;
    const entry = readArchiveIndex(
      path.join(this.home(), THREADS_DIR_NAME),
      this.log
    ).archived[sessionId];
    if (entry === undefined) return false;
    // The twin holds the archived bytes (by time for a pre-fingerprint twin).
    return twin.source.fingerprint !== undefined
      ? entry.fingerprint === twin.source.fingerprint
      : entry.updatedAt === twin.source.updatedAt;
  }

  private convert(
    sessionId: string,
    v1: Extract<V1Read, { status: "ok" }>,
    afterClear: string | undefined
  ): ThreadFileV2 {
    return v1ToThreadFile({
      threadId: sessionId,
      ...v1.meta,
      segments: v1.segments,
      ...(afterClear !== undefined && afterClear !== "" && { afterClear }),
    });
  }

  private repair(
    sessionId: string,
    threadFile: string,
    v1: Extract<V1Read, { status: "ok" }>,
    afterClear: string | undefined
  ): ThreadFileV2 {
    const thread = this.convert(sessionId, v1, afterClear);
    // An oversized v1 file is served, never persisted as a twin.
    if (v1.large) return thread;
    this.persist(sessionId, threadFile, thread, "repair");
    return thread;
  }

  private readMarker(sessionId: string): ClearMarker | null {
    return parseMarkerRead(this.held.read(this.markerPath(sessionId)));
  }

  private readV1(file: string): V1Read {
    const pending = this.held.pending(file);
    let text: string;
    if (pending !== null) {
      if (pending.op === "remove") return { status: "missing" };
      text = pending.text;
    } else {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        return {
          status:
            code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
        };
      }
      if (size > this.maxStreamedBytes) return { status: "tooLarge", size };
      if (size > this.maxTranscriptBytes) {
        // Streamed and hashed on the way: the clear rules below still apply.
        const streamed = streamTranscriptV1(file);
        if (streamed.status !== "ok") return { status: streamed.status };
        return {
          status: "ok",
          meta: {
            updatedAt: streamed.updatedAt ?? v1UpdatedAt(file, {}),
            fingerprint: streamed.fingerprint,
          },
          segments: streamed.segments,
          large: true,
        };
      }
      const read = readTextChecked(file);
      if (read.status !== "ok")
        return {
          status: read.status === "tooLarge" ? "unreadable" : read.status,
        };
      text = read.text;
    }
    const parsed = parseTranscriptV1(text);
    if (parsed.status !== "ok") return { status: "invalid" };
    return {
      status: "ok",
      meta: {
        updatedAt: v1UpdatedAt(file, parsed.file),
        fingerprint: fingerprintV1(text),
      },
      segments: parsed.file.segments,
      large: Buffer.byteLength(text) > this.maxTranscriptBytes,
    };
  }

  /** The current marker's token, for a write made after a clear. */
  private afterClear(sessionId: string): { afterClear?: string } {
    const marker = this.readMarker(sessionId);
    return marker === null || marker.token === ""
      ? {}
      : { afterClear: marker.token };
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
    reason: "repair" | "agui",
    rethrow = false
  ): void {
    try {
      if (this.held.write(file, JSON.stringify(thread)) === "written") {
        const stat = fs.statSync(file);
        this.written.set(sessionId, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          kind: reason === "agui" ? "agui" : "v1",
        });
      } else this.written.delete(sessionId);
    } catch (error) {
      this.written.delete(sessionId);
      if (rethrow) throw error;
      // The repaired thread is still returned; the next read tries again.
      this.log(`${reason} of ${sessionId} failed: ${String(error)}`);
      return;
    }
    // Written after the clear, and carrying its token: the marker is done.
    if (thread.source.afterClear !== undefined)
      try {
        this.held.remove(this.markerPath(sessionId));
      } catch (error) {
        this.log(`clear marker of ${sessionId}: ${String(error)}`);
      }
  }
}
