import type { StatusEvent } from "@abacus-ai/contract/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const statusRouter = impl.status.router({
  list: impl.status.list.handler(({ context }) =>
    context.deps.serviceHost.statusBoard.list()
  ),
  events: impl.status.events.handler(({ context, signal }) =>
    stream<StatusEvent>({
      path: "status.events",
      context,
      signal,
      attach: onIpcEvents(context, isType("status-updated"), () => ({
        type: "updated" as const,
      })),
      coalesceKey: (event) => event.type,
    })
  ),
});
