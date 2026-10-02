import { impl } from "./impl";

export const sessionsRouter = impl.sessions.router({
  turnState: impl.sessions.turnState.handler(({ input, context }) =>
    context.deps.serviceHost.getSessionTurnState(
      input.workspaceId,
      input.sessionId
    )
  ),
});
