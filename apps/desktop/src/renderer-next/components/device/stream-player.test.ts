import { expect, it, vi } from "vitest";

import { codecFromSps, DeviceStreamPlayer } from "./stream-player";
it("R4-T32 parses Annex-B SPS and ignores deltas before the key-frame barrier", async () => {
  expect(codecFromSps(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e]))).toBe(
    "avc1.42001e"
  );
  expect(codecFromSps(new Uint8Array([0, 0, 1, 0x65, 1, 2]))).toBe(null);
  const context = vi.fn();
  const fatal = vi.fn();
  const player = new DeviceStreamPlayer(
    { getContext: context } as never,
    fatal
  );
  await player.push({
    streamId: 1,
    data: new Uint8Array([1, 2]),
    isKey: false,
  });
  expect(context).not.toHaveBeenCalled();
  expect(fatal).not.toHaveBeenCalled();
  player.dispose();
});
it("falls back after five seconds without a decoded frame and cancels the watchdog on disposal", async () => {
  vi.useFakeTimers();
  const fatal = vi.fn();
  const player = new DeviceStreamPlayer(
    { getContext: vi.fn() } as never,
    fatal
  );
  await vi.advanceTimersByTimeAsync(4999);
  expect(fatal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fatal).toHaveBeenCalledTimes(1);
  player.dispose();
  const stopped = new DeviceStreamPlayer({} as never, fatal);
  stopped.dispose();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fatal).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

it("reopens an overflowing H264 decoder at the next keyframe", async () => {
  const decoders: Array<{
    state: string;
    decodeQueueSize: number;
    close: ReturnType<typeof vi.fn>;
    decode: ReturnType<typeof vi.fn>;
    configure: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal(
    "VideoDecoder",
    class {
      state = "unconfigured";
      decodeQueueSize = 0;
      close = vi.fn(() => {
        this.state = "closed";
      });
      decode = vi.fn();
      configure = vi.fn(() => {
        this.state = "configured";
      });
      constructor() {
        decoders.push(this);
      }
    }
  );
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(public input: unknown) {}
    }
  );
  const fatal = vi.fn();
  const player = new DeviceStreamPlayer({} as never, fatal);
  const key = {
    streamId: 1,
    isKey: true,
    data: new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e]),
  };
  try {
    await player.push(key);
    expect(decoders[0]!.state).toBe("configured");
    player.resetBarrier();
    await player.push({ ...key, isKey: false });
    expect(decoders[0]!.decode).toHaveBeenCalledTimes(1);
    await player.push(key);
    expect(decoders[0]!.decode).toHaveBeenCalledTimes(2);
    decoders[0]!.decodeQueueSize = 9;
    await player.push({ ...key, isKey: false });
    expect(decoders[0]!.close).toHaveBeenCalledTimes(1);
    await player.push({ ...key, isKey: false });
    expect(decoders).toHaveLength(1);
    await player.push(key);
    expect(decoders).toHaveLength(2);
    expect(decoders[1]!.decode).toHaveBeenCalledTimes(1);
    expect(fatal).not.toHaveBeenCalled();
  } finally {
    player.dispose();
    vi.unstubAllGlobals();
  }
});
