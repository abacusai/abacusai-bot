import type { DevicesEvent } from "@abacus-ai/contract/contract";
import type { DeviceStreamChunk } from "@abacus-ai/contract/contracts";

import { DEVICE_CHUNK_MAX_BYTES } from "../delivery";
import { deviceChunkSender } from "../device-chunks";
import { forbidden } from "../errors";
import {
  impl,
  isType,
  onChannel,
  onIpcEvents,
  requireWindow,
  stream,
} from "./impl";

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
      const { bus } = context.deps;
      // The same dual delivery the legacy handler uses.
      return context.deps.serviceHost.startDeviceStream(
        input,
        deviceChunkSender(contents, (channel, chunk) =>
          bus.dispatchChannel(channel, chunk)
        )
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
    /**
     * Opens on a key frame: the stream's current group of pictures (its last
     * key frame, which carries the codec configuration, and every frame
     * since), recorded from startup, so neither a subscriber that arrives
     * after capture began nor one reopening after RESYNC_REQUIRED starts on
     * an undecodable delta frame. With nothing recorded yet, live frames are
     * held back until the first key frame.
     */
    chunks: impl.devices.stream.chunks.handler(({ input, context, signal }) => {
      let awaitingKey = true;
      return stream<DeviceStreamChunk>({
        path: "devices.stream.chunks",
        context,
        signal,
        attach: onChannel(context, "device-chunk", (chunk) => {
          if (chunk.streamId !== input.streamId) return null;
          if (awaitingKey) {
            if (!chunk.isKey) return null;
            awaitingKey = false;
          }
          return chunk;
        }),
        initial: () => {
          const replay = context.deps.trackers.deviceStreamReplay(
            input.streamId
          );
          if (replay.length > 0) awaitingKey = false;
          return replay;
        },
        sizeOf: (chunk) => chunk.data.byteLength,
        maxBytes: DEVICE_CHUNK_MAX_BYTES,
      });
    }),
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
