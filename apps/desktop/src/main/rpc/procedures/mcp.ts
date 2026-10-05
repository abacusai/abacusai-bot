import type { McpRuntimeEvent } from "@abacus-ai/contract/contract";
import type { IpcEvent } from "@abacus-ai/contract/contracts";

import { impl, isType, onIpcEvents, stream } from "./impl";

const toRuntimeEvent = (event: IpcEvent): McpRuntimeEvent | null => {
  switch (event.type) {
    case "mcp-runtime-servers":
      return {
        type: "servers",
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        servers: event.servers,
      };
    case "mcp-runtime-status": {
      const { type: _type, emittedAt: _at, ...rest } = event;
      return { type: "status", ...rest };
    }
    case "mcp-runtime-log":
      return {
        type: "log",
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        entry: event.entry,
      };
    case "mcp-runtime-refresh-failed":
      return {
        type: "refresh-failed",
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        error: event.error,
        ts: event.ts,
      };
    case "mcp-runtime-restart-failed":
      return {
        type: "restart-failed",
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        serverId: event.serverId,
        error: event.error,
        ts: event.ts,
      };
    default:
      return null;
  }
};

export const mcpRouter = impl.mcp.router({
  list: impl.mcp.list.handler(({ input, context }) =>
    context.deps.serviceHost.listMcpServers(input)
  ),
  add: impl.mcp.add.handler(({ input, context }) =>
    context.deps.serviceHost.addMcpServer(input)
  ),
  update: impl.mcp.update.handler(({ input, context }) =>
    context.deps.serviceHost.updateMcpServer(input)
  ),
  remove: impl.mcp.remove.handler(({ input, context }) =>
    context.deps.serviceHost.removeMcpServer(input)
  ),
  setDisabled: impl.mcp.setDisabled.handler(({ input, context }) =>
    context.deps.serviceHost.setMcpServerDisabled(input)
  ),
  import: impl.mcp.import.handler(({ input, context }) =>
    context.deps.serviceHost.importMcpServers(input)
  ),
  refresh: impl.mcp.refresh.handler(({ input, context }) =>
    context.deps.serviceHost.refreshMcpServersForSession(input)
  ),
  restart: impl.mcp.restart.handler(({ input, context }) =>
    context.deps.serviceHost.restartMcpServerForSession(input)
  ),
  oauthSignIn: impl.mcp.oauthSignIn.handler(({ input, context }) =>
    context.deps.serviceHost.mcpOAuthSignIn(input)
  ),
  runtime: {
    servers: impl.mcp.runtime.servers.handler(({ input, context }) =>
      context.deps.serviceHost.getMcpRuntimeServersForSession(input)
    ),
    logs: impl.mcp.runtime.logs.handler(({ input, context }) =>
      context.deps.serviceHost.getMcpServerLogsForSession(input)
    ),
    events: impl.mcp.runtime.events.handler(({ input, context, signal }) => {
      const sessionId = input?.sessionId;
      return stream<McpRuntimeEvent>({
        path: "mcp.runtime.events",
        context,
        signal,
        attach: onIpcEvents(
          context,
          (event) =>
            isType(
              "mcp-runtime-servers",
              "mcp-runtime-status",
              "mcp-runtime-log",
              "mcp-runtime-refresh-failed",
              "mcp-runtime-restart-failed"
            )(event) &&
            (sessionId == null || event.sessionId === sessionId),
          toRuntimeEvent
        ),
        // Server lists and statuses are full states; log lines and failures
        // are each their own event (the full log is `mcp.runtime.logs`).
        coalesceKey: (event) =>
          event.type === "servers"
            ? `servers:${event.sessionId}`
            : event.type === "status"
              ? `status:${event.sessionId}:${event.serverId}`
              : null,
      });
    }),
  },
});
