import type { UpdateStatus } from "@abacus-ai/contract/update";

import { UPDATE_USER_MESSAGES } from "../../services/updates/update-messages";
import { conflict, unwrapResult } from "../errors";

/** An answer's own words reach the user only when the service wrote them for one. */
const refused = (reason: string) =>
  conflict(reason, reason, UPDATE_USER_MESSAGES.has(reason));
import { impl, onChannel, stream } from "./impl";

export const updateRouter = impl.update.router({
  check: impl.update.check.handler(async ({ context }) => {
    unwrapResult(await context.deps.update.checkForUpdates(), refused);
  }),
  install: impl.update.install.handler(async ({ context }) => {
    unwrapResult(
      await context.deps.update.installUpdate({ whenSafe: true }),
      refused
    );
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
