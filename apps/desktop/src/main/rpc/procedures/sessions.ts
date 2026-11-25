import { badRequest, forbidden, notFound } from "../errors";
import { impl } from "./impl";

export const sessionsRouter = impl.sessions.router({
  turnState: impl.sessions.turnState.handler(({ input, context }) =>
    context.deps.serviceHost.getSessionTurnState(
      input.workspaceId,
      input.sessionId
    )
  ),
  folders: {
    add: impl.sessions.folders.add.handler(async ({ input, context }) => {
      const { serviceHost } = context.deps;
      if (serviceHost.sessionFolders(input.sessionId) == null)
        throw notFound("session", input.sessionId);
      const added = await serviceHost.addSessionFolder(
        input.sessionId,
        input.path
      );
      if (added.ok === false)
        throw added.error === "folder-not-allowed"
          ? forbidden(added.error)
          : badRequest(added.error);
      return { folders: serviceHost.sessionFolders(input.sessionId) ?? [] };
    }),
    remove: impl.sessions.folders.remove.handler(({ input, context }) => {
      const { serviceHost } = context.deps;
      if (serviceHost.sessionFolders(input.sessionId) == null)
        throw notFound("session", input.sessionId);
      serviceHost.removeSessionFolder(input.sessionId, input.path);
      return { folders: serviceHost.sessionFolders(input.sessionId) ?? [] };
    }),
  },
});
