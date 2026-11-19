import type { StatusEvent } from "@abacus-ai/contract/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const statusRouter = impl.status.router({
  list: impl.status.list.handler(({ context }) =>
    context.deps.serviceHost.statusBoard.list()
  ),
  connectivity: impl.status.connectivity.handler(({ context }) =>
    context.deps.serviceHost.connectivity.snapshot()
  ),
  events: impl.status.events.handler(({ context, signal }) =>
    stream<StatusEvent>({
      path: "status.events",
      context,
      signal,
      attach: onIpcEvents(
        context,
        isType("status-updated", "connectivity-updated"),
        (event) => ({
          type:
            event.type === "connectivity-updated"
              ? ("connectivity" as const)
              : ("updated" as const),
        })
      ),
      coalesceKey: (event) => event.type,
    })
  ),
});
