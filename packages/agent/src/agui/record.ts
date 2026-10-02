/**
 * `ABACUSAI_BOT_WIRE_RECORD=<path>` (spec §6.3, §7.1): the NDJSON host
 * appends one JSON line per stdin line and per event, in the order the host
 * saw them, for fixtures and for debugging a live session:
 *
 *   {"dir":"in","line":"<the raw stdin line>"}
 *   {"dir":"out","event":<DesktopEvent>,"meta":{...}}   pre-strip: `meta` holds
 *                                                        the internal facts
 *                                                        (origin, subagentRunId,
 *                                                        parentToolCallId, ...)
 *   {"dir":"internal","event":<InternalAgentEvent>}     never on the wire
 *
 * Recording never changes what stdout carries: `out` entries are written
 * beside the unchanged stdout line, and serialising each `event` alone gives
 * that line byte for byte. Writes are synchronous so a crash keeps the tail.
 */
import * as fs from "node:fs";

import { eventMeta } from "../event-meta.js";
import type { InternalAgentEvent } from "../internal-events.js";
import type { DesktopEvent } from "../protocol.js";

export const WIRE_RECORD_ENV = "ABACUSAI_BOT_WIRE_RECORD";

export type WireRecordEntry =
  | { dir: "in"; line: string }
  | { dir: "out"; event: DesktopEvent; meta?: Record<string, unknown> }
  | { dir: "internal"; event: InternalAgentEvent };

export interface WireRecorder {
  input(line: string): void;
  output(event: DesktopEvent): void;
  internal(event: InternalAgentEvent): void;
}

/** The internal facts of an event or of its wrapped agent event, if any. */
function metaOf(event: DesktopEvent): Record<string, unknown> | undefined {
  const facts = {
    ...eventMeta(event),
    ...(event.type === "event" ? eventMeta(event.event) : {}),
  };

  return Object.keys(facts).length > 0 ? facts : undefined;
}

/**
 * A recorder appending to `target`, or undefined when recording is off. A
 * target that cannot be opened is reported on stderr and recording stays off:
 * a debugging aid must never take the session down.
 */
export function openWireRecorder(
  target: string | undefined,
  log: (line: string) => void = (line) => void process.stderr.write(line)
): WireRecorder | undefined {
  if (target == null || target.length === 0) return undefined;

  let fd: number;

  try {
    fd = fs.openSync(target, "a");
  } catch (error) {
    log(
      `[abacusai-bot-agent] ${WIRE_RECORD_ENV}: cannot open ${target}: ${error instanceof Error ? error.message : String(error)}\n`
    );

    return undefined;
  }

  let broken = false;
  const append = (entry: WireRecordEntry): void => {
    if (broken) return;

    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      broken = true;
      log(
        `[abacusai-bot-agent] ${WIRE_RECORD_ENV}: recording stopped: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  };

  return {
    input: (line) => append({ dir: "in", line }),
    output: (event) => {
      const meta = metaOf(event);

      append(
        meta != null ? { dir: "out", event, meta } : { dir: "out", event }
      );
    },
    internal: (event) => append({ dir: "internal", event }),
  };
}

/** Parses a recording back into its entries. */
export function readWireRecording(text: string): WireRecordEntry[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WireRecordEntry);
}
