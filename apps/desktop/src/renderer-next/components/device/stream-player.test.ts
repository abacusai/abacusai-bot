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
