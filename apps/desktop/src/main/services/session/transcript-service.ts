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

const TRANSCRIPTS_DIR = (): string => path.join(abacusBotHome(), "transcripts");

// Ids arrive over IPC: a path separator or leading dot would let a caller
// write outside the transcripts folder.
const isSafeSessionId = (sessionId: string): boolean =>
  typeof sessionId === "string" &&
  /^[A-Za-z0-9._-]+$/.test(sessionId) &&
  !sessionId.startsWith(".");

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

export class TranscriptService {
  // Fires after the atomic rename; optional so persistence never depends on it.
  private onPersist?: (sessionId: string) => void;

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
  }
}
