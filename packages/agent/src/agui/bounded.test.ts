/**
 * Bounded bookkeeping (spec §5.2, main relay review r2 #4): the per-run and
 * per-message records a long-lived runtime keeps forget their oldest
 * entries past their limit, and still answer for everything inside it.
 */
import { describe, expect, it } from "vitest";

import {
  BoundedMap,
  BoundedSet,
  MESSAGE_IDS_KEPT,
  RUN_IDS_KEPT,
  RUN_OUTCOMES_KEPT,
} from "./bounded.js";
import { noCompat } from "./channel.js";
import { AguiEmitter } from "./emit.js";
import { RunController } from "./runs.js";
import { HostSink } from "./sink.js";
import type { AguiEvent } from "./wire.js";

describe("BoundedSet and BoundedMap", () => {
  it("forget the oldest entries past the limit; a re-add is the newest", () => {
    const set = new BoundedSet<string>(3);
    for (const item of ["a", "b", "c"]) set.add(item);
    set.add("a");
    set.add("d");
    expect(["a", "b", "c", "d"].filter((item) => set.has(item))).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(set.size).toBe(3);

    const map = new BoundedMap<string, number>(2);
    map.set("x", 1).set("y", 2).set("x", 3).set("z", 4);
    expect([map.get("x"), map.get("y"), map.get("z")]).toEqual([
      3,
      undefined,
      4,
    ]);
    expect(map.has("y")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("keeps the retry window no smaller than main's ack record", () => {
    // Main answers a repeat from its own 10,000-run record (relay-service
    // ACKS_KEPT) and forwards it only once it has forgotten it.
    expect(RUN_IDS_KEPT).toBeGreaterThanOrEqual(10_000);
    expect(RUN_OUTCOMES_KEPT).toBeGreaterThanOrEqual(1);
    expect(MESSAGE_IDS_KEPT).toBeGreaterThanOrEqual(1_024);
  });
});

describe("a long-lived runtime's bookkeeping stays bounded", () => {
  it("run ids, outcomes and message ids, over more runs than any limit", () => {
    const out: AguiEvent[] = [];
    const sink = new HostSink(noCompat);
    const runs: RunController = new RunController({
      threadId: "t-1",
      write: (event) => sink.writeAgui(event),
      closeOpenParts: () => emitter.closeOpenParts(),
      model: () => emitter.model(),
      onOpen: () => emitter.runOpened(),
    });
    const emitter: AguiEmitter = new AguiEmitter({
      threadId: "t-1",
      incarnation: "inc-1",
      runs,
      approvalTimeoutMs: () => Number.POSITIVE_INFINITY,
      now: () => 0,
      log: () => undefined,
    });
    sink.attach({
      emitter,
      runs,
      write: (line) => out.push(JSON.parse(line) as AguiEvent),
    });

    const total = RUN_IDS_KEPT + 50;
    for (let n = 1; n <= total; n += 1) {
      const runId = `run-${n}`;
      const token = runs.mint(runId);
      runs.open(token, runId, { serverInitiated: false });
      // Each failed run gets its own error anchor id.
      for (const event of emitter.errorAnchor(runId)) sink.writeAgui(event);
      runs.markCancelling(token);
      runs.settle(token);
      out.length = 0;
    }

    const internals = (value: object) =>
      value as unknown as Record<string, { size: number }>;
    expect(internals(runs).seenRunIds!.size).toBe(RUN_IDS_KEPT);
    expect(internals(runs).outcomes!.size).toBe(RUN_OUTCOMES_KEPT);
    expect(internals(emitter).usedMessageIds!.size).toBe(MESSAGE_IDS_KEPT);

    // Inside the window everything still answers; past it, forgotten.
    expect(runs.hasSeen(`run-${total}`)).toBe(true);
    expect(runs.hasSeen(`run-${total - RUN_IDS_KEPT + 1}`)).toBe(true);
    expect(runs.hasSeen("run-1")).toBe(false);
    expect(runs.outcomeOf(`run-${total}`)).toBe("cancelled");
  });
});
