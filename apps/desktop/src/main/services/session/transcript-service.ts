/**
 * On-disk transcripts, one JSON file per session: the renderer hands over the
 * conversation's persistable segments and gets the same array back on open.
 * A file per session keeps one save from rewriting every other transcript;
 * writes are atomic because a half-written file would poison the session.
 *
 * A transcript an unresolved migration commit may cover
 * (`isMigrationWriteBlocked`, spec 00 C.1) is not written or removed this
 * launch: the change is kept in memory and `read` returns it, so the session
 * keeps working, and the next launch's rollback can neither overwrite it nor
 * be defeated by it.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import { isMigrationWriteBlocked } from "../../migrations/write-block";
import { abacusBotHome } from "../../paths";
import { isSafeSessionId, type ThreadStore } from "./thread-store";

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
  private readonly isWriteBlocked: (file: string) => boolean;
  private readonly now: () => Date;
  private readonly writeFile: (file: string, text: string) => void;
  /** Held in memory while the file is write-blocked (null: removed). */
  private readonly overlay = new Map<string, StoredTranscript | null>();

  constructor(options: TranscriptServiceOptions = {}) {
    this.threads = options.threads;
    this.isWriteBlocked = options.isWriteBlocked ?? isMigrationWriteBlocked;
    this.now = options.now ?? (() => new Date());
    this.writeFile = options.writeFile ?? writeFileAtomicSync;
  }

  setOnPersist(callback: (sessionId: string) => void): void {
    this.onPersist = callback;
  }

  read(sessionId: string): StoredTranscript | null {
    const filePath = transcriptPath(sessionId);
    if (filePath == null) return null;
    if (this.overlay.has(sessionId)) return this.overlay.get(sessionId) ?? null;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as StoredTranscript;
      if (parsed?.version !== 1 || !Array.isArray(parsed?.segments))
        return null;

      return parsed;
    } catch {
      // Missing is normal before the first save; corrupt degrades to empty.
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
    if (this.isWriteBlocked(filePath)) {
      if (!this.overlay.has(sessionId))
        console.error(
          `[transcripts] ${sessionId} is held by an unresolved migration; saves stay in memory this launch`
        );
      this.overlay.set(sessionId, payload);
    } else {
      try {
        this.writeFile(filePath, text);
      } catch (error) {
        console.error("[transcripts] failed to write transcript", error);
        return;
      }
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
    if (this.isWriteBlocked(filePath)) {
      this.overlay.set(sessionId, null);
    } else {
      try {
        fs.rmSync(filePath, { force: true });
        this.overlay.delete(sessionId);
      } catch (error) {
        console.error("[transcripts] failed to remove transcript", error);
      }
    }
    try {
      this.threads?.remove(sessionId);
    } catch (error) {
      console.error("[transcripts] failed to remove the v2 thread", error);
    }
  }
}
