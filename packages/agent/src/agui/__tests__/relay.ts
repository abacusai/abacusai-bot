/**
 * Main's AG-UI relay, reduced to what hydration needs (spec §5.3): a
 * per-thread StreamProcessor transcript persisted at every terminal, each
 * run's complete event log (the active one unbounded; completed ones kept in
 * a small ring), the latest descriptor set, and a monotonic sequence number.
 * `hydrate` reads them in one synchronous turn; `joinRun` replays the run's
 * log from its RUN_STARTED and then tails, so nothing between the checkpoint
 * and the replay is lost or doubled. The agent's contract under test: stdout
 * alone is enough.
 */
import { StreamProcessor, type UIMessage } from "@tanstack/ai";
import type { SubscribeConnectionAdapter } from "@tanstack/ai-client";

import type { AguiEvent, PermissionDescriptor } from "../wire.js";

type ChatHydrationResult = Awaited<
  ReturnType<NonNullable<SubscribeConnectionAdapter["hydrate"]>>
>;

const COMPLETED_RUNS_KEPT = 8;

const isTerminalFor = (event: AguiEvent, runId: string): boolean =>
  (event.type === "RUN_FINISHED" && event.runId === runId) ||
  (event.type === "RUN_ERROR" &&
    (event as { metadata?: { tanstack?: { runId?: string } } }).metadata
      ?.tanstack?.runId === runId);

export class Relay {
  private seq = 0;
  private readonly processor = new StreamProcessor();
  private transcript: UIMessage[] = [];
  private activeRunId: string | null = null;
  private readonly logs = new Map<string, AguiEvent[]>();
  private descriptors: PermissionDescriptor[] = [];
  private incarnation = "";
  private readonly listeners = new Set<(event: AguiEvent) => void>();

  ingest(event: AguiEvent): void {
    this.seq += 1;
    this.processor.processChunk(event as never);

    if (event.type === "RUN_STARTED") {
      this.activeRunId = event.runId;
      this.logs.set(event.runId, []);
      while (this.logs.size > COMPLETED_RUNS_KEPT + 1) {
        this.logs.delete(this.logs.keys().next().value!);
      }
    }
    if (this.activeRunId != null) this.logs.get(this.activeRunId)?.push(event);
    if (event.type === "CUSTOM" && event.name === "permission.pending") {
      this.descriptors = (
        event.value as { items: PermissionDescriptor[] }
      ).items;
    }
    if (event.type === "CUSTOM" && event.name === "wire.hello") {
      this.incarnation = (event.value as { incarnation: string }).incarnation;
    }
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      this.transcript = structuredClone(this.processor.getMessages());
      this.activeRunId = null;
    }

    for (const listener of this.listeners) listener(event);
  }

  /** The atomic checkpoint. */
  hydrate(): ChatHydrationResult & {
    cursor: number;
    descriptors: PermissionDescriptor[];
  } {
    return {
      messages: structuredClone(this.transcript),
      activeRun: this.activeRunId != null ? { runId: this.activeRunId } : null,
      interrupts: null,
      cursor: this.seq,
      // Dead incarnations are dropped at hydrate (§5.3 item 6).
      descriptors: this.descriptors.filter(
        (item) =>
          this.incarnation === "" ||
          item.metadata.abacus.lineage.incarnation === this.incarnation
      ),
    };
  }

  /** The run's log from RUN_STARTED, then live until its terminal. */
  joinRun(runId: string, signal?: AbortSignal): AsyncIterable<AguiEvent> {
    const log = this.logs.get(runId) ?? [];
    const listeners = this.listeners;

    return {
      async *[Symbol.asyncIterator]() {
        const live: AguiEvent[] = [];
        let wake: (() => void) | undefined;
        let ended = false;
        // Subscribed before the replay is read: the log and the live tail
        // meet exactly, in this one synchronous turn.
        const listener = (event: AguiEvent): void => {
          live.push(event);
          wake?.();
        };

        listeners.add(listener);
        signal?.addEventListener("abort", () => {
          ended = true;
          wake?.();
        });

        const replay = [...log];

        try {
          for (const event of replay) {
            yield event;
            if (isTerminalFor(event, runId)) return;
          }
          for (;;) {
            while (live.length === 0 && !ended) {
              await new Promise<void>((resolve) => (wake = resolve));
            }
            if (live.length === 0) return;
            const event = live.shift()!;

            yield event;
            if (isTerminalFor(event, runId)) return;
          }
        } finally {
          listeners.delete(listener);
        }
      },
    };
  }

  messages(): UIMessage[] {
    return this.processor.getMessages();
  }
}
