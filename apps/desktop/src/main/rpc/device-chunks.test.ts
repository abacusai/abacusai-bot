/**
 * Device mirror chunks (Codex impl-r1 #4, #5): one dual-delivering sender for
 * both start paths, and a subscription that always opens on a key frame,
 * however late it arrives or however often it reopens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeviceStreamChunk } from "#shared/contracts";

import { DEVICE_CHUNK_MAX_BYTES } from "./delivery";
import { LEGACY_DEVICE_CHUNK_CHANNEL } from "./device-chunks";
import { MainEventBus } from "./event-bus";
import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "./testing";

const connections: InProcessConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const chunk = (
  streamId: number,
  frame: number,
  isKey: boolean
): DeviceStreamChunk => ({
  streamId,
  data: new Uint8Array([frame]),
  isKey,
  format: "h264",
});

const frames = (chunks: DeviceStreamChunk[]) =>
  chunks.map((c) => `${c.isKey ? "K" : "d"}${c.data[0]}`);

const setup = () => {
  const bus = new MainEventBus();
  const send = vi.fn();
  const contents = { id: 1, send, isDestroyed: () => false };
  let sender: Electron.WebContents | null = null;
  const deps = fakeDeps({
    bus,
    windows: { contents: () => contents as never },
    serviceHost: {
      startDeviceStream: async (
        _request: unknown,
        given: Electron.WebContents
      ) => {
        sender = given;
        return { success: true, streamId: 5 };
      },
    },
  });
  const connection = connectInProcess(deps);
  connections.push(connection);
  /** What the stream services do with the sender they were handed. */
  const emit = (c: DeviceStreamChunk): void =>
    sender!.send(LEGACY_DEVICE_CHUNK_CHANNEL, c);
  return { bus, send, client: connection.client, emit };
};

const take = async (
  iterator: AsyncIterator<DeviceStreamChunk>,
  count: number
): Promise<DeviceStreamChunk[]> => {
  const out: DeviceStreamChunk[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await iterator.next();
    if (result.done === true) break;
    out.push(result.value);
  }
  return out;
};

describe("devices.stream.start over RPC", () => {
  it("delivers each chunk to the legacy channel and to the bus", async () => {
    const { bus, send, client, emit } = setup();
    await client.devices.stream.start({
      platform: "android",
      deviceId: "emulator-5554",
    });
    const published: DeviceStreamChunk[] = [];
    bus.listenChannel("device-chunk", (c) => published.push(c));

    emit(chunk(5, 1, true));

    expect(send).toHaveBeenCalledExactlyOnceWith(
      LEGACY_DEVICE_CHUNK_CHANNEL,
      chunk(5, 1, true)
    );
    expect(frames(published)).toEqual(["K1"]);
  });
});

describe("devices.stream.chunks opens on a key frame", () => {
  it("replays what capture sent before the subscriber arrived", async () => {
    const { client, emit } = setup();
    const { streamId } = await client.devices.stream.start({
      platform: "android",
      deviceId: "emulator-5554",
    });
    // scrcpy drains video before `start` has even returned the id.
    emit(chunk(5, 1, true));
    emit(chunk(5, 2, false));
    emit(chunk(5, 3, false));

    const chunks = await client.devices.stream.chunks({ streamId: streamId! });
    const replay = take(chunks, 4);
    await new Promise((resolve) => setTimeout(resolve, 10));
    emit(chunk(5, 4, false));

    expect(frames(await replay)).toEqual(["K1", "d2", "d3", "d4"]);
    await chunks.return();
  });

  it("replays from the latest key frame only", async () => {
    const { client, emit } = setup();
    await client.devices.stream.start({ platform: "android", deviceId: "d" });
    emit(chunk(5, 1, true));
    emit(chunk(5, 2, false));
    emit(chunk(5, 3, true));
    emit(chunk(5, 4, false));

    const chunks = await client.devices.stream.chunks({ streamId: 5 });
    expect(frames(await take(chunks, 2))).toEqual(["K3", "d4"]);
    await chunks.return();
  });

  it("holds live delta frames back until the first key frame", async () => {
    const { client, emit } = setup();
    await client.devices.stream.start({ platform: "android", deviceId: "d" });
    const chunks = await client.devices.stream.chunks({ streamId: 5 });
    const first = take(chunks, 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    emit(chunk(5, 1, false));
    emit(chunk(5, 2, false));
    emit(chunk(5, 3, true));
    emit(chunk(5, 4, false));

    expect(frames(await first)).toEqual(["K3", "d4"]);
    await chunks.return();
  });

  it("reopens on the current group of pictures", async () => {
    const { client, emit } = setup();
    await client.devices.stream.start({ platform: "android", deviceId: "d" });
    emit(chunk(5, 1, true));
    const firstOpen = await client.devices.stream.chunks({ streamId: 5 });
    await take(firstOpen, 1);
    emit(chunk(5, 2, false));
    await take(firstOpen, 1);
    // The subscriber drops (a RESYNC_REQUIRED, a reload) and reopens.
    await firstOpen.return();
    emit(chunk(5, 3, false));

    const reopened = await client.devices.stream.chunks({ streamId: 5 });
    expect(frames(await take(reopened, 3))).toEqual(["K1", "d2", "d3"]);
    await reopened.return();
  });

  it("does not keep a group that outgrows the byte cap", () => {
    const bus = new MainEventBus();
    const deps = fakeDeps({ bus });
    const big = (isKey: boolean): DeviceStreamChunk => ({
      streamId: 9,
      data: new Uint8Array(DEVICE_CHUNK_MAX_BYTES / 2 + 1),
      isKey,
    });
    bus.dispatchChannel("device-chunk", big(true));
    expect(deps.trackers.deviceStreamReplay(9)).toHaveLength(1);
    bus.dispatchChannel("device-chunk", big(false));
    expect(deps.trackers.deviceStreamReplay(9)).toEqual([]);
    bus.dispatchChannel("device-chunk", big(true));
    expect(deps.trackers.deviceStreamReplay(9)).toHaveLength(1);
  });
});
