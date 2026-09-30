/**
 * The fixture player (spec 02 §11.1): a scenario on a fake relay, under a
 * real `ChatRuntime`, so gallery entries and screenshots run the session,
 * pump, dispatcher, store and kit exactly as production does.
 * `step=<n>` stops after the n-th event (deterministic mid-stream states);
 * `play=1` streams the rest with a short delay per event; a send is echoed
 * and answered with the scenario's reply.
 */
import type { StreamChunk } from "@tanstack/ai";

import { inertHostActions } from "../runtime/host-actions";
import { createChatRuntime, type ChatRuntime } from "../runtime/runtime";
import * as b from "./builders";
import { FakeRelay } from "./relay";
import { scenarioById, type Scenario } from "./scenarios";

export interface PlayOptions {
  /** Stop after this many events (default: all). */
  step?: number;
  /** Stream the remaining events live. */
  play?: boolean;
  delayMs?: number;
}

export interface FixtureRuntime {
  runtime: ChatRuntime;
  relay: FakeRelay;
  scenario: Scenario;
  threadId: string;
}

const echoAndReply = (relay: FakeRelay, runId: string, messageId: string, text: string, reply: string): void => {
  const events: StreamChunk[] = [
    b.runStarted(runId, { timestamp: Date.now() }),
    ...b.text(messageId, "user", text),
    ...b.text(`${runId}:a`, "assistant", reply),
    b.runFinished(runId, "success", { timestamp: Date.now() + 1200 }),
  ];
  events.forEach((event, index) => setTimeout(() => relay.emit(event), 120 * (index + 1)));
};

/** A runtime whose one thread (`threadId`) replays the scenario. */
export const fixtureRuntime = (
  scenarioId: string,
  options: PlayOptions = {},
  threadId = "t-1"
): FixtureRuntime | null => {
  const scenario = scenarioById(scenarioId);
  if (scenario == null) return null;
  const all = scenario.events();
  const cut = options.step == null ? all.length : Math.max(0, Math.min(all.length, options.step));
  const relay = new FakeRelay({
    threadId,
    events: all.slice(0, cut),
    ...(scenario.history != null ? { history: scenario.history() } : {}),
    onSend: (input, r) => {
      const message = input.messages[0];
      const text = (message?.parts[0] as { content?: string } | undefined)?.content ?? "";
      if (r.activeRun() != null) return { runId: input.runId, status: "queued" };
      echoAndReply(r, input.runId, message?.id ?? input.runId, text, scenario.reply ?? "Done.");
      return { runId: input.runId, status: "started" };
    },
    onCancel: (_input, r) => {
      const active = r.activeRun();
      if (active != null) r.emit(b.runFinished(active.runId, "cancelled"));
    },
    onRespond: (input, r) => {
      const lineage = input.lineage as { permissionId: string; incarnation: string };
      r.emitAll([
        b.custom("permission.resolved", { permissionId: lineage.permissionId, decisionKind: "accept", source: "respond" }),
        b.custom("permission.pending", { incarnation: lineage.incarnation, items: [] }),
      ]);
    },
    onQueue: (command, input, r) => {
      if (command === "remove" || command === "clear")
        r.emit(b.custom("queue.updated", { messages: [], dequeued: null }));
      if (command === "enqueue")
        r.emit(
          b.custom("queue.updated", {
            messages: [{ id: "q-9", message: String(input.message), waitingFor: "turn" }],
            dequeued: null,
          })
        );
    },
  });
  if (options.play === true) {
    const delay = options.delayMs ?? 180;
    all.slice(cut).forEach((item, index) => setTimeout(() => relay.emit(item.event), delay * (index + 1)));
  }
  const runtime = createChatRuntime(relay.ai, { host: inertHostActions });
  return { runtime, relay, scenario, threadId };
};
