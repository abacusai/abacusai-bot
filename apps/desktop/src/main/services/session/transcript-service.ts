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
   * Clears the current thread alongside its retained legacy source.
   */
  threads?: ThreadStore;
  /** Defaults to the migration runner's `isMigrationWriteBlocked`. */
  isWriteBlocked?: (file: string) => boolean;
  /** Test seam for write failures. */
  writeFile?: (file: string, text: string) => void;
}

export class TranscriptService {
  private readonly threads?: ThreadStore;
  /**
   * The thread store's instance when there is one, memory fallback included,
   * so the store converts exactly the v1 save this service holds.
   */
  private readonly held: HeldFiles;

  constructor(options: TranscriptServiceOptions = {}) {
    this.threads = options.threads;
    this.held =
      options.threads?.held ??
      new HeldFiles({
        dir: () => path.join(abacusBotHome(), THREADS_DIR_NAME, ".pending"),
        isWriteBlocked: options.isWriteBlocked ?? isMigrationWriteBlocked,
        writeFile: options.writeFile ?? writeFileAtomicSync,
        log: (message) => console.error(`[transcripts] ${message}`),
      });
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
