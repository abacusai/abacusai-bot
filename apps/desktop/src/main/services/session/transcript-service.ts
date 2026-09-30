/**
 * On-disk transcripts, one JSON file per session: the renderer hands over the
 * conversation's persistable segments and gets the same array back on open.
 * A file per session keeps one save from rewriting every other transcript;
 * writes are atomic because a half-written file would poison the session.
 *
 * A transcript an unresolved migration commit may cover
 * (`isMigrationWriteBlocked`, spec 00 C.1) is not written or removed: the
 * change is journalled (`HeldFiles`, `threads/.pending/`), `read` and the
 * thread store see it, and it is replayed onto the file once the block
 * lifts, so a save made while recovery is unresolved survives a quit.
 */
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import { isMigrationWriteBlocked } from "../../migrations/write-block";
import { abacusBotHome } from "../../paths";
import { HeldFiles } from "./held-files";
import {
  isSafeSessionId,
  THREADS_DIR_NAME,
  type ThreadStore,
} from "./thread-store";

const TRANSCRIPTS_DIR = (): string => path.join(abacusBotHome(), "transcripts");

const transcriptPath = (sessionId: string): string | null =>
  isSafeSessionId(sessionId)
    ? path.join(TRANSCRIPTS_DIR(), `${sessionId}.json`)
    : null;

export interface StoredTranscript {
  version: 1;
  sessionId: string;
  updatedAt: string;
  segments: unknown[];
}

export interface TranscriptServiceOptions {
  /**
   * The v2 twin (spec 00 C.3): written after every v1 write and cleared with
   * the v1 file, for the transition until main persists v2 itself.
   */
  threads?: ThreadStore;
  /** Defaults to the migration runner's `isMigrationWriteBlocked`. */
  isWriteBlocked?: (file: string) => boolean;
  /** The clock for `updatedAt` (tests). */
  now?: () => Date;
  /** Test seam for write failures. */
  writeFile?: (file: string, text: string) => void;
}

export class TranscriptService {
  // Fires after the atomic rename; optional so persistence never depends on it.
  private onPersist?: (sessionId: string) => void;
  private readonly threads?: ThreadStore;
  private readonly now: () => Date;
  /**
   * The thread store's instance when there is one, memory fallback included,
   * so the store converts exactly the v1 save this service holds.
   */
  private readonly held: HeldFiles;
  private readonly writeFile: (file: string, text: string) => void;

  constructor(options: TranscriptServiceOptions = {}) {
    this.threads = options.threads;
    this.now = options.now ?? (() => new Date());
    this.writeFile = options.writeFile ?? writeFileAtomicSync;
    this.held =
      options.threads?.held ??
      new HeldFiles({
        dir: () => path.join(abacusBotHome(), THREADS_DIR_NAME, ".pending"),
        isWriteBlocked: options.isWriteBlocked ?? isMigrationWriteBlocked,
        writeFile: options.writeFile ?? writeFileAtomicSync,
        log: (message) => console.error(`[transcripts] ${message}`),
      });
  }

  setOnPersist(callback: (sessionId: string) => void): void {
    this.onPersist = callback;
  }

  read(sessionId: string): StoredTranscript | null {
    const filePath = transcriptPath(sessionId);
    if (filePath == null) return null;
    const read = this.held.read(filePath);
    // Missing is normal before the first save; corrupt degrades to empty.
    if (read.status !== "ok") return null;
    try {
      const parsed = JSON.parse(read.text) as StoredTranscript;
      if (parsed?.version !== 1 || !Array.isArray(parsed?.segments))
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(sessionId: string, segments: unknown[]): void {
    const filePath = transcriptPath(sessionId);
    if (filePath == null) return;
    // Never overwrite a good file with an empty one: the store is empty for a
    // moment on every start, before hydration. Deletion goes through `remove`.
    if (!Array.isArray(segments) || segments.length === 0) return;
    const payload: StoredTranscript = {
      version: 1,
      sessionId,
      updatedAt: this.now().toISOString(),
      segments,
    };
    const text = JSON.stringify(payload);
    try {
      this.held.write(filePath, text, this.writeFile);
    } catch (error) {
      console.error("[transcripts] failed to write transcript", error);
      return;
    }
    // A save after a clear is what proves the v1 file is new history.
    try {
      this.threads?.noteSave(sessionId, text);
    } catch (error) {
      console.error("[transcripts] failed to note the save", error);
    }
    // Isolated: a failed v2 write is repaired by the next `readCurrent`, and
    // must not stop `onPersist`. The fingerprint is of the exact v1 text.
    try {
      this.threads?.writeFromV1(sessionId, { ...payload, text });
    } catch (error) {
      console.error("[transcripts] failed to write the v2 thread", error);
    }
    // Only after a clean persist; a listener error must not reach the write path.
    try {
      this.onPersist?.(sessionId);
    } catch (error) {
      console.error("[transcripts] onPersist listener threw", error);
    }
  }

  /**
   * Clears the conversation: the clear marker first (so a failure anywhere
   * after it cannot bring the history back through `ai.hydrate`), then the
   * v1 file, then the v2 twin.
   */
  remove(sessionId: string): void {
    const filePath = transcriptPath(sessionId);
    if (filePath == null) return;
    try {
      this.threads?.markCleared(sessionId);
    } catch (error) {
      console.error("[transcripts] failed to mark the thread cleared", error);
    }
    try {
      this.held.remove(filePath);
    } catch (error) {
      console.error("[transcripts] failed to remove transcript", error);
    }
    try {
      this.threads?.remove(sessionId);
    } catch (error) {
      console.error("[transcripts] failed to remove the v2 thread", error);
    }
  }
}
