/**
 * Device mirror chunks, delivered twice (spec 00 A.4.3): the stream services
 * push each chunk to a webContents with `send`, and the sender they are given
 * is this proxy, which keeps that legacy send and publishes the same chunk on
 * the bus for `devices.stream.chunks`. Both start paths (the legacy
 * `ipcMain.handle` and the `devices.stream.start` procedure) use it, so the
 * old and the new renderer see the same chunks whichever started the stream.
 *
 * No Electron at runtime: only its types.
 */
import type { DeviceStreamChunk } from "#shared/contracts";

import type { BusChannels } from "./event-bus";

/** services/device/device-stream-service.ts's DEVICE_STREAM_CHUNK_CHANNEL. */
export const LEGACY_DEVICE_CHUNK_CHANNEL = "agent:device-stream-chunk";

export type PublishDeviceChunk = (
  channel: "device-chunk",
  payload: BusChannels["device-chunk"]
) => void;

export const deviceChunkSender = (
  contents: Electron.WebContents,
  publish: PublishDeviceChunk
): Electron.WebContents =>
  new Proxy(contents, {
    get(target, property, receiver) {
      if (property === "send")
        return (channel: string, ...args: unknown[]): void => {
          try {
            // The legacy renderer, unchanged.
            target.send(channel, ...args);
          } finally {
            if (channel === LEGACY_DEVICE_CHUNK_CHANNEL)
              publish("device-chunk", args[0] as DeviceStreamChunk);
          }
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
