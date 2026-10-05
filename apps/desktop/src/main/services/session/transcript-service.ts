/**
 * On-disk transcripts, one JSON file per session: the renderer hands over the
 * conversation's persistable segments and gets the same array back on open.
 * A file per session keeps one save from rewriting every other transcript;
 * writes are atomic because a half-written file would poison the session.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

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
   * The v2 twin (spec 00 C.3): written after every v1 write and removed with
   * the v1 file, for the transition until main persists v2 itself.
   */
  threads?: ThreadStore;
}

export class TranscriptService {
  // Fires after the atomic rename; optional so persistence never depends on it.
  private onPersist?: (sessionId: string) => void;
  private readonly threads?: ThreadStore;

  constructor(options: TranscriptServiceOptions = {}) {
    this.threads = options.threads;
  }

  setOnPersist(callback: (sessionId: string) => void): void {
    this.onPersist = callback;
  }

  read(sessionId: string): StoredTranscript | null {
    const filePath = transcriptPath(sessionId);
    if (filePath == null) return null;
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
      updatedAt: new Date().toISOString(),
      segments,
    };
    try {
      writeFileAtomicSync(filePath, JSON.stringify(payload));
    } catch (error) {
      console.error("[transcripts] failed to write transcript", error);
      return;
    }
    // Isolated: a failed v2 write is repaired by the next `readCurrent`, and
    // must not stop `onPersist`.
    try {
      this.threads?.writeFromV1(sessionId, payload);
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

  remove(sessionId: string): void {
    const filePath = transcriptPath(sessionId);
    if (filePath == null) return;
    try {
      fs.rmSync(filePath, { force: true });
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
