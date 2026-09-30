/**
 * State an iterator snapshots on (re)open that no service keeps, followed
 * from the bus for the process's lifetime.
 */
import type { DeviceBuildPhase } from "#shared/contracts";

import type { EventTrackers } from "./deps";
import type { MainEventBus } from "./event-bus";

export const createEventTrackers = (bus: MainEventBus): EventTrackers => {
  let deviceBuild: { phase: DeviceBuildPhase; error?: string } | null = null;

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

  return { deviceBuild: () => deviceBuild };
};
