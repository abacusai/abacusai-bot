import type { UpdateStatus } from "#shared/update";

import { unwrapResult } from "../errors";
import { impl, onChannel, stream } from "./impl";

export const updateRouter = impl.update.router({
  check: impl.update.check.handler(async ({ context }) => {
    unwrapResult(await context.deps.update.checkForUpdates());
  }),
  install: impl.update.install.handler(async ({ context }) => {
    unwrapResult(await context.deps.update.installUpdate());
  }),
  status: impl.update.status.handler(({ context }) =>
    context.deps.update.getStatus()
  ),
  events: impl.update.events.handler(({ context, signal }) =>
    stream<UpdateStatus>({
      path: "update.events",
      context,
      signal,
      attach: onChannel(context, "update", (status) => status),
      // The first yield is the current status.
      initial: () => [context.deps.update.getStatus()],
      coalesceKey: () => "status",
    })
  ),
});
