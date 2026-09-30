import type { DevicesEvent } from "#shared/contract";
import type { DeviceStreamChunk } from "#shared/contracts";

import { DEVICE_CHUNK_MAX_BYTES } from "../delivery";
import { forbidden } from "../errors";
import type { MainEventBus } from "../event-bus";
import {
  impl,
  isType,
  onChannel,
  onIpcEvents,
  requireWindow,
  stream,
} from "./impl";

/** services/device/device-stream-service.ts's DEVICE_STREAM_CHUNK_CHANNEL. */
export const LEGACY_DEVICE_CHUNK_CHANNEL = "agent:device-stream-chunk";

/**
 * The stream services push chunks to a webContents with `send`. For a stream
 * started over RPC, that webContents is this proxy: its chunks go to the bus
 * (and `devices.stream.chunks`) instead of the legacy channel, and everything
 * else the services ask of it goes to the real window.
 */
export const chunkSenderFor = (
  contents: Electron.WebContents,
  bus: MainEventBus
): Electron.WebContents =>
  new Proxy(contents, {
    get(target, property, receiver) {
      if (property === "send")
        return (channel: string, ...args: unknown[]): void => {
          if (channel === LEGACY_DEVICE_CHUNK_CHANNEL)
            bus.dispatchChannel("device-chunk", args[0] as DeviceStreamChunk);
          else target.send(channel, ...args);
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

export const devicesRouter = impl.devices.router({
  status: impl.devices.status.handler(({ context }) =>
    context.deps.serviceHost.getDeviceStatus()
  ),
  list: impl.devices.list.handler(({ context }) =>
    context.deps.serviceHost.listLocalDevices()
  ),
  screenshot: impl.devices.screenshot.handler(({ input, context }) =>
    context.deps.serviceHost.captureDeviceScreenshot(input)
  ),
  boot: impl.devices.boot.handler(({ input, context }) =>
    context.deps.serviceHost.bootLocalDevice(input)
  ),
  create: impl.devices.create.handler(({ input, context }) =>
    context.deps.serviceHost.createLocalDevice(input)
  ),
  refresh: impl.devices.refresh.handler(({ context }) =>
    context.deps.serviceHost.refreshDeviceStatus()
  ),
  setEnabled: impl.devices.setEnabled.handler(({ input, context }) =>
    context.deps.serviceHost.setDevicesEnabled(input.enabled)
  ),
  setApproval: impl.devices.setApproval.handler(({ input, context }) =>
    context.deps.serviceHost.setDevicesApproval(input.approval)
  ),
  projectInfo: impl.devices.projectInfo.handler(({ context }) =>
    context.deps.serviceHost.getDeviceProjectInfo()
  ),
  interact: impl.devices.interact.handler(({ input, context }) =>
    context.deps.serviceHost.interactLocalDevice(input)
  ),
  buildAndRun: impl.devices.buildAndRun.handler(({ input, context }) =>
    context.deps.serviceHost.buildAndRunLocalDevice(input)
  ),
  stream: {
    start: impl.devices.stream.start.handler(({ input, context }) => {
      const contents = context.deps.windows.contents(requireWindow(context));
      if (contents == null) throw forbidden("The calling window is gone");
      return context.deps.serviceHost.startDeviceStream(
        input,
        chunkSenderFor(contents, context.deps.bus)
      );
    }),
    stop: impl.devices.stream.stop.handler(({ input, context }) =>
      context.deps.serviceHost.stopDeviceStream(input?.streamId)
    ),
    touch: impl.devices.stream.touch.handler(({ input, context }) => {
      context.deps.serviceHost.streamDeviceTouch(input);
    }),
    key: impl.devices.stream.key.handler(({ input, context }) => {
      context.deps.serviceHost.streamDeviceKey(input);
    }),
    chunks: impl.devices.stream.chunks.handler(({ input, context, signal }) =>
      stream<DeviceStreamChunk>({
        path: "devices.stream.chunks",
        context,
        signal,
        attach: onChannel(context, "device-chunk", (chunk) =>
          chunk.streamId === input.streamId ? chunk : null
        ),
        sizeOf: (chunk) => chunk.data.byteLength,
        maxBytes: DEVICE_CHUNK_MAX_BYTES,
      })
    ),
  },
  simulatorWindowSource: impl.devices.simulatorWindowSource.handler(
    ({ input, context }) =>
      context.deps.serviceHost.getSimulatorWindowSource(input)
  ),
  installMaestro: impl.devices.installMaestro.handler(({ context }) =>
    context.deps.serviceHost.installMaestro()
  ),
  events: impl.devices.events.handler(({ context, signal }) =>
    stream<DevicesEvent>({
      path: "devices.events",
      context,
      signal,
      attach: onIpcEvents(
        context,
        isType("device-status-updated", "device-build-state"),
        (event): DevicesEvent | null =>
          event.type === "device-status-updated"
            ? { type: "status", status: event.status }
            : event.type === "device-build-state"
              ? {
                  type: "build-state",
                  phase: event.phase,
                  ...(event.error == null ? {} : { error: event.error }),
                }
              : null
      ),
      initial: () => [
        {
          type: "snapshot",
          status: context.deps.serviceHost.getDeviceStatus(),
          buildPhase: context.deps.trackers.deviceBuild()?.phase ?? null,
        },
      ],
      // Build phases are delivered in order; the status is a full state.
      coalesceKey: (event) => (event.type === "status" ? "status" : null),
    })
  ),
});
