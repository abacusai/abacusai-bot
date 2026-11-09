import type { RoutinesEvent } from "@abacus-ai/contract/contract";

import { isHostedRoutineId } from "../../services/agent-tools/hosted-routines";
import { unavailable } from "../errors";
import { impl, stream } from "./impl";

export const routinesRouter = impl.routines.router({
  editByChat: impl.routines.editByChat.handler(async ({ input, context }) => ({
    reply: await context.deps.serviceHost.editRoutineByChat(
      input.routineId,
      input.text,
      input.runId
    ),
  })),
  replyToRun: impl.routines.replyToRun.handler(({ input, context }) =>
    context.deps.serviceHost.replyToRoutineRun(
      input.routineId,
      input.runId,
      input.text
    )
  ),
  run: impl.routines.run.handler(({ input, context }) =>
    context.deps.host.runRoutine(input.id, input.trigger)
  ),
  hostedRuns: impl.routines.hostedRuns.handler(async ({ input, context }) => {
    // A local routine has no runs on the server.
    if (!isHostedRoutineId(input.id)) return [];
    try {
      return await context.deps.serviceHost.hostedRoutines.runs(input.id);
    } catch {
      throw unavailable("The routine's runs could not be read right now.");
    }
  }),
  refreshHosted: impl.routines.refreshHosted.handler(async ({ context }) => {
    const hosted = context.deps.serviceHost.hostedRoutines;
    await hosted.refresh();
    return { hosted: await hosted.capability() };
  }),
  runners: impl.routines.runners.handler(async ({ context }) => {
    const host = context.deps.serviceHost;
    // The desktop app keeps no routines on the server: the form offers none.
    if (host.platform !== "web-host")
      return { hosted: false, default: "local" };
    return {
      hosted: await host.hostedRoutines.capability(),
      default: host.defaultRoutineRunner(),
    };
  }),
  events: impl.routines.events.handler(({ context, signal }) =>
    stream<RoutinesEvent>({
      path: "routines.events",
      context,
      signal,
      attach: (push) => {
        const started = context.deps.serviceHost.onRoutineRunStarted((event) =>
          push({ type: "run-started", ...event })
        );
        // Hosted results are read only while someone listens here.
        const hosted = context.deps.serviceHost.onHostedRun((event) =>
          push(
            event.type === "away"
              ? { type: "hosted-away", runs: event.runs }
              : { type: "hosted-run", run: event.run }
          )
        );
        const created = context.deps.serviceHost.onRoutineCreatedByAgent(
          (routine) =>
            push({
              type: "created",
              routineId: routine.id,
              name: routine.name,
            })
        );
        return () => {
          started();
          hosted();
          created();
        };
      },
    })
  ),
});
