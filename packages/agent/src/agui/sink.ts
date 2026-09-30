/**
 * `HostSink`: the one `emit()` both wires use (spec §2.4). Every legacy
 * `DesktopEvent` becomes exactly the NDJSON line `NdjsonHost` has always
 * written, on the compat channel (stdout itself under `--wire ndjson`), and
 * then, under `--wire agui`, the AG-UI events the emitter derives from it.
 */
import type { InternalAgentEvent } from "../internal-events.js";
import type { DesktopEvent } from "../protocol.js";
import type { CompatWriter } from "./channel.js";
import type { AguiEmitter } from "./emit.js";
import { isRunScoped, serialize } from "./event.js";
import type { RunController } from "./runs.js";
import type { AguiEvent } from "./wire.js";

/** The legacy line for one event: byte-identical to NdjsonHost.emit. */
export function toNdjsonWire(event: DesktopEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export interface AguiSide {
  emitter: AguiEmitter;
  runs: RunController;
  /** Writes one already-serialized stdout line. */
  write: (line: string) => void;
}

export class HostSink {
  private agui: AguiSide | undefined;
  private closed = false;

  constructor(private readonly compat: CompatWriter) {}

  attach(agui: AguiSide): void {
    this.agui = agui;
  }

  /** After compat loss or at exit: nothing more reaches stdout through here. */
  close(): void {
    this.closed = true;
  }

  emit(event: DesktopEvent): void {
    this.compat.write(toNdjsonWire(event));

    const agui = this.agui;

    if (agui == null) return;

    // A reset's cancelled terminal comes before its notice (§3.3.2 :2350).
    if (event.type === "event" && event.event.type === "segments_cleared") {
      agui.runs.settleOpen();
    }

    for (const out of agui.emitter.accept(event)) this.writeAgui(out);
  }

  internal(event: InternalAgentEvent): void {
    const agui = this.agui;

    if (agui == null) return;

    for (const out of agui.emitter.acceptInternal(event)) this.writeAgui(out);
  }

  /** One AG-UI event to stdout; run-scoped events only inside an open run. */
  writeAgui(event: AguiEvent): void {
    const agui = this.agui;

    if (agui == null || this.closed) return;
    if (isRunScoped(event) && !agui.runs.isOpen()) return;

    agui.write(serialize(event));
  }
}
