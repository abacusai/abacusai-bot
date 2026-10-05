import { impl } from "./impl";

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
});
