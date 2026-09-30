/**
 * State an iterator snapshots on (re)open that no service keeps, followed
 * from the bus for the process's lifetime.
 */
import type { DeviceBuildPhase, DeviceStreamChunk } from "#shared/contracts";

import { DEVICE_CHUNK_MAX_BYTES } from "./delivery";
import type { EventTrackers } from "./deps";
import type { MainEventBus } from "./event-bus";

/** Device streams whose group of pictures is kept; one streams at a time. */
const MAX_TRACKED_DEVICE_STREAMS = 4;

export const createEventTrackers = (bus: MainEventBus): EventTrackers => {
  let deviceBuild: { phase: DeviceBuildPhase; error?: string } | null = null;
  const groups = new Map<
    number,
    { chunks: DeviceStreamChunk[]; bytes: number }
  >();

  // From capture start, before any subscriber: scrcpy drains video before
  // `start` even returns the stream id a subscriber needs.
  bus.listenChannel("device-chunk", (chunk) => {
    let group = groups.get(chunk.streamId);
    if (chunk.isKey) {
      groups.delete(chunk.streamId);
      group = { chunks: [], bytes: 0 };
      groups.set(chunk.streamId, group);
      if (groups.size > MAX_TRACKED_DEVICE_STREAMS) {
        const oldest = groups.keys().next().value;
        if (oldest != null) groups.delete(oldest);
      }
    }
    // Nothing decodable to replay until the first key frame.
    if (group == null) return;
    group.chunks.push(chunk);
    group.bytes += chunk.data.byteLength;
    // Too long without a key frame to replay; the next one starts over.
    if (group.bytes > DEVICE_CHUNK_MAX_BYTES) groups.delete(chunk.streamId);
  });

  bus.listen(
    (event) => event.type === "device-build-state",
    (event) => {
      if (event.type !== "device-build-state") return;
      deviceBuild = {
        phase: event.phase,
        ...(event.error == null ? {} : { error: event.error }),
      };
    }
  );

  return {
    deviceBuild: () => deviceBuild,
    deviceStreamReplay: (streamId) => [...(groups.get(streamId)?.chunks ?? [])],
  };
};
