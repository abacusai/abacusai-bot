/** Test-only simulation of a pre-cutover renderer save. Never imported by production. */
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import { abacusBotHome } from "../../paths";
import type { HeldFiles } from "./held-files";
import { isSafeSessionId } from "./thread-store";
import type { ThreadStore } from "./thread-store";
import { TranscriptService, type StoredTranscript } from "./transcript-service";
export type {
  TranscriptServiceOptions,
  StoredTranscript,
} from "./transcript-service";
const transcriptPath = (id: string) =>
  isSafeSessionId(id)
    ? path.join(abacusBotHome(), "transcripts", `${id}.json`)
    : null;
interface LegacyWriter {
  filePath(id: string): string | null;
  now(): Date;
  held: HeldFiles;
  writeFile(file: string, text: string): void;
  threads?: ThreadStore;
  onPersist?: (id: string) => void;
}
export type TranscriptServiceOptions =
  import("./transcript-service").TranscriptServiceOptions & {
    now?: () => Date;
  };
export class LegacyTranscriptFixture extends TranscriptService {
  private readonly now: () => Date;
  private readonly writeFile: (file: string, text: string) => void;
  private onPersist?: (id: string) => void;
  constructor(options: TranscriptServiceOptions = {}) {
    super(options);
    this.now = options.now ?? (() => new Date());
    this.writeFile = options.writeFile ?? writeFileAtomicSync;
  }
  setOnPersist(callback: (id: string) => void) {
    this.onPersist = callback;
  }
  write(sessionId: string, segments: unknown[]): void {
    const fixture = this as unknown as LegacyWriter;
    const filePath = transcriptPath(sessionId);
    if (filePath == null) return;
    // Never overwrite a good file with an empty one: the store is empty for a
    // moment on every start, before hydration. Deletion goes through `remove`.
    if (!Array.isArray(segments) || segments.length === 0) return;
    const payload: StoredTranscript = {
      version: 1,
      sessionId,
      updatedAt: fixture.now().toISOString(),
      segments,
    };
    const text = JSON.stringify(payload);
    try {
      fixture.held.write(filePath, text, fixture.writeFile);
    } catch (error) {
      console.error("[transcripts] failed to write transcript", error);
      return;
    }
    // A save after a clear is what proves the v1 file is new history.
    try {
      fixture.threads?.noteSave(sessionId, text);
    } catch (error) {
      console.error("[transcripts] failed to note the save", error);
    }
    // Isolated: a failed v2 write is repaired by the next `readCurrent`, and
    // must not stop `onPersist`. The fingerprint is of the exact v1 text.
    try {
      fixture.threads?.readCurrent(sessionId);
    } catch (error) {
      console.error("[transcripts] failed to write the v2 thread", error);
    }
    // Only after a clean persist; a listener error must not reach the write path.
    try {
      fixture.onPersist?.(sessionId);
    } catch (error) {
      console.error("[transcripts] onPersist listener threw", error);
    }
  }
}
