import type { RoutinesEvent } from "@abacus-ai/contract/contract";

import { impl, stream } from "./impl";

export const routinesRouter = impl.routines.router({
  editByChat: impl.routines.editByChat.handler(async ({ input, context }) => ({
    reply: await context.deps.serviceHost.editRoutineByChat(
      input.routineId,
      input.text
    ),
  })),
  run: impl.routines.run.handler(({ input, context }) =>
    context.deps.host.runRoutine(input.id, input.trigger)
  ),
  events: impl.routines.events.handler(({ context, signal }) =>
    stream<RoutinesEvent>({
      path: "routines.events",
      context,
      signal,
      attach: (push) =>
        context.deps.serviceHost.onRoutineRunStarted((event) =>
          push({ type: "run-started", ...event })
        ),
    })
  ),
});
