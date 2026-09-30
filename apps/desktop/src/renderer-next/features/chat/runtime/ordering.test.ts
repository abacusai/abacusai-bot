/**
 * R2-T3 (spec 02 §3.4 "Why the order is total"): a seeded property test.
 * Hydrate at a random checkpoint, join replay, live events in random
 * batches, iterator failures at random positions and generation restarts
 * (resync): the final generation's client ends equal to a fresh
 * `StreamProcessor` fed every event once, in order.
 */
import { StreamProcessor, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { restoreInboundChunk } from "@tanstack/ai/client";
import { describe, expect, it, vi } from "vitest";

import { golden } from "../fixtures/goldens";
import { FakeRelay } from "../fixtures/relay";
import { ThreadSession } from "./session";

const SEQUENCES = 2000;
const GOLDENS = [
  "plain-text",
  "tool-bash",
  "permission-accept",
  "permission-two-calls",
  "delegate-colliding-ids",
  "stop-mid-stream",
  "steer-and-queue",
  "todo-plan",
  "turn-failed",
] as const;

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const timeless = (messages: readonly UIMessage[]): unknown =>
  JSON.parse(
    JSON.stringify(messages, (key, value: unknown) =>
      key === "createdAt" ? undefined : value
    )
  );

const expected = (events: readonly StreamChunk[]): unknown => {
  const processor = new StreamProcessor();
  for (const event of events) {
    try {
      processor.processChunk(restoreInboundChunk(structuredClone(event)));
    } catch {
      // as main and the client
    }
  }
  return timeless(processor.getMessages());
};

describe("R2-T3 ordering", () => {
  it(`every seq exactly once, in order, over ${SEQUENCES} seeded sequences`, async () => {
    const cache = new Map(GOLDENS.map((name) => [name, golden(name)]));
    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      const random = mulberry32(seed);
      const name = GOLDENS[Math.floor(random() * GOLDENS.length)]!;
      const events = cache.get(name)!;
      const cut = Math.floor(random() * (events.length + 1));
      const relay = new FakeRelay({ events: events.slice(0, cut) });
      const joinFailAt = random() < 0.3 ? Math.floor(random() * 6) : -1;
      relay.faults.joinRun = (call, delivered) =>
        call === 1 && delivered === joinFailAt ? new Error("lost") : null;
      const session = new ThreadSession({
        ai: relay.ai,
        threadId: relay.threadId,
        recoveryDelaysMs: [0, 0, 0, 0, 0, 0, 0, 0],
        pumpRetryDelaysMs: [0, 0, 0, 0],
      });
      try {
        await session.load();
        let index = cut;
        while (index < events.length) {
          const size = 1 + Math.floor(random() * 6);
          const roll = random();
          if (roll < 0.1) {
            relay.dropSubscriptions();
          } else if (roll < 0.15) {
            // A resync: the resume point falls out of the ring.
            relay.dropSubscriptions();
            relay.floor = relay.lastSeq + 1;
          }
          const batch = events.slice(index, index + size);
          relay.emitAll(batch.map((item) => item.event));
          if (roll >= 0.1 && roll < 0.15) relay.floor = relay.lastSeq;
          index += size;
          if (random() < 0.5) await Promise.resolve();
        }
        await vi.waitFor(
          () => {
            const positions = session.positions();
            expect(session.ready).toBe(true);
            expect(positions?.appliedSeq).toBe(relay.lastSeq);
          },
          { timeout: 2000, interval: 1 }
        ).catch((error: unknown) => {
          throw new Error(
            `seed ${seed} ${name} cut ${cut} joinFailAt ${joinFailAt} gen ${session.gen} ` +
              JSON.stringify(session.positions()) +
              ` host ${JSON.stringify({ phase: session.hostStore.state.phase, connection: session.hostStore.state.connection })} ` +
              String(error)
          );
        });
        const messages = session.hostStore.state.client!.getMessages();
        expect(
          { seed, name, cut, messages: timeless(messages) },
          `seed ${seed}`
        ).toEqual({
          seed,
          name,
          cut,
          messages: expected(events.map((item) => item.event)),
        });
      } finally {
        session.retire();
      }
    }
  }, 120_000);
});
