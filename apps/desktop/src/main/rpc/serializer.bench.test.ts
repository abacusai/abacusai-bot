/**
 * A-T8: device stream chunks through the Uint8Array serializer, handler and
 * link over a real MessageChannel. 1,000 chunks of 64 KB; the median time
 * from main publishing a chunk to the renderer's iterator yielding it.
 *
 * Informational: the target is 5 ms (spec 00 A.6); this fails only above
 * 20 ms, so a loaded machine does not turn it red. The measured median is
 * printed for the PR.
 */
import { afterEach, describe, expect, it } from "vitest";

import { MainEventBus } from "./event-bus";
import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "./testing";

const CHUNKS = 1_000;
const CHUNK_BYTES = 64 * 1024;
const FAIL_ABOVE_MS = 20;

let connection: InProcessConnection | null = null;

afterEach(() => {
  connection?.closeClient();
  connection?.closeServer();
  connection = null;
});

describe("device stream serialization (A-T8)", () => {
  it(`carries ${CHUNKS} × 64 KB chunks with a median under ${FAIL_ABOVE_MS} ms`, async () => {
    const bus = new MainEventBus();
    connection = connectInProcess(fakeDeps({ bus }));
    const chunks = await connection.client.devices.stream.chunks({
      streamId: 7,
    });
    // Let the subscription register before the first chunk.
    const warmup = new Uint8Array(16);
    const first = chunks.next();
    while (bus.listenerCount() < 2) await new Promise((r) => setTimeout(r, 1));
    bus.dispatchChannel("device-chunk", {
      streamId: 7,
      data: warmup,
      isKey: true,
    });
    await first;

    const payload = new Uint8Array(CHUNK_BYTES).map((_, i) => i % 251);
    const timings: number[] = [];
    for (let i = 0; i < CHUNKS; i += 1) {
      const started = performance.now();
      const received = chunks.next();
      bus.dispatchChannel("device-chunk", {
        streamId: 7,
        data: payload,
        isKey: i % 60 === 0,
      });
      const { value } = (await received) as { value?: { data: Uint8Array } };
      timings.push(performance.now() - started);
      if (i === 0) {
        expect(value?.data).toBeInstanceOf(Uint8Array);
        expect(value?.data.byteLength).toBe(CHUNK_BYTES);
        expect(value?.data[250]).toBe(250);
      }
    }
    await chunks.return();

    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)]!;
    const p95 = timings[Math.floor(timings.length * 0.95)]!;
    console.info(
      `[A-T8] ${CHUNKS} × ${CHUNK_BYTES / 1024} KB chunks: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms (target 5 ms)`
    );
    expect(median).toBeLessThan(FAIL_ABOVE_MS);
  });
});
