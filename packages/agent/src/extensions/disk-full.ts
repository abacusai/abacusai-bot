/**
 * A tool whose write failed because this computer's disk is full. The turn's
 * chain records it, so the turn ends on the full-disk card (turn-outcome.ts);
 * the model is told once to stop writing, and a write after that stops the run.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { freeBytes, isDiskFull } from "../atomic-file.js";
import type { TurnChain } from "../turn-outcome.js";

/**
 * Free space under which a tool's "no space left" is this disk's. Tool text
 * alone could be about another volume, or quoted from a log.
 */
const DISK_FULL_BELOW_BYTES = 256 * 1024 * 1024;

/** The line of a tool's output that says the disk is full, as the chain records it. */
const diskFullLine = (text: string): string | null => {
  const line = text.split("\n").find((candidate) => isDiskFull(candidate));
  if (line == null) return null;
  // The chain classifies by text: led by the code, never by a number that reads as a status.
  return `ENOSPC: no space left on device (${line.trim().slice(0, 300)})`;
};

const modelNote = (free: number | undefined): string =>
  `The disk on this computer is full${free != null ? ` (${Math.floor(free / 1_000_000)} MB free)` : ""}, ` +
  "so this write failed and every further write will fail too. Do not retry it or write anything else. " +
  "Stop here and tell the user, in their language, that the disk is full and to free some space, then try again.";

export default function diskFull(chain: () => TurnChain) {
  return (pi: ExtensionAPI): void => {
    pi.on("tool_result", (event, ctx) => {
      const text = event.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      const line = diskFullLine(text);
      if (line == null) return;
      const free = freeBytes(ctx.sessionManager.getSessionDir() || ctx.cwd);
      if (free != null && free >= DISK_FULL_BELOW_BYTES) return;
      const told = chain().diskFull;
      chain().failed(line, undefined);
      // Told already and still writing: the run stops here.
      if (told) ctx.abort();
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: modelNote(free) },
        ],
      };
    });
  };
}
