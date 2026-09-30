/**
 * The delivery class every event iterator declares (spec 00 A.4.3). The
 * procedures build their queues from this table, and A-T9 asserts it against
 * the spec's, so a change here is a change to what may be dropped.
 */
import type { DeliveryClass } from "./subscriber-queue";

export const DELIVERY = {
  "terminal.output": "lossless-replayable",
  "terminal.events": "lossless-actionable",
  // Permission asks, previews and materialized runtimes are lossless; cursor,
  // status and runtime state coalesce (browserCoalesceKey).
  "browser.events": "lossless-actionable",
  "connectors.events": "lossless-actionable",
  "devices.events": "lossless-actionable",
  // Its own replay ring behind the AguiSource.
  "ai.subscribe": "lossless-actionable",
  "ai.joinRun": "lossless-actionable",
  // Run ends feed unread and cues; attention is a snapshot plus changes.
  "ai.runFinished": "lossless-actionable",
  "ai.attention": "lossless-actionable",
  // Video frames: a dropped delta frame corrupts every frame until the next
  // key frame, so nothing is dropped; overflow ends the stream and the
  // player restarts it, which begins on a key frame.
  "devices.stream.chunks": "lossless-actionable",
  "mcp.runtime.events": "coalescing",
  "update.events": "coalescing",
  "window.events": "coalescing",
  "system.events": "coalescing",
  "settings.events": "coalescing",
  "messaging.events": "coalescing",
  "bots.events": "coalescing",
  "memory.events": "coalescing",
  "localModels.progress": "coalescing",
  "voice.whisper.progress": "coalescing",
  "files.events": "coalescing",
} as const satisfies Record<string, DeliveryClass>;

export type StreamPath = keyof typeof DELIVERY;

/** The device stream's byte cap: a few seconds of 60 fps H.264. */
export const DEVICE_CHUNK_MAX_BYTES = 16 * 1024 * 1024;
