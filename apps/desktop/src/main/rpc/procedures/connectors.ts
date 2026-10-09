import type { ConnectorsEvent } from "@abacus-ai/contract/contract";

import { impl, isType, onIpcEvents, stream } from "./impl";

export const connectorsRouter = impl.connectors.router({
  statuses: impl.connectors.statuses.handler(({ context }) =>
    context.deps.serviceHost.listConnectorStatuses()
  ),
  connect: impl.connectors.connect.handler(({ input, context }) =>
    context.deps.serviceHost.connectConnector(input.connectorId)
  ),
  submitFields: impl.connectors.submitFields.handler(({ input, context }) =>
    context.deps.serviceHost.submitConnectorFields(
      input.connectorId,
      input.values
    )
  ),
  // Connecting no longer waits in the host; older clients still call this.
  cancelConnect: impl.connectors.cancelConnect.handler(({ input, context }) =>
    context.deps.serviceHost.cancelConnect(input?.connectorId)
  ),
  disconnect: impl.connectors.disconnect.handler(({ input, context }) =>
    context.deps.serviceHost.disconnectConnector(input.connectorId)
  ),
  respond: impl.connectors.respond.handler(async ({ input, context }) => {
    await context.deps.serviceHost.respondConnector(input);
  }),
  requests: impl.connectors.requests.handler(({ input, context }) =>
    context.deps.serviceHost.listConnectorRequests(input.conversationKey)
  ),
  // Asks are lossless and re-snapshotted on (re)open, so one is never lost:
  // at worst it is announced twice.
  events: impl.connectors.events.handler(({ input, context, signal }) => {
    const key = input?.conversationKey;
    return stream<ConnectorsEvent>({
      path: "connectors.events",
      context,
      signal,
      attach: onIpcEvents(
        context,
        isType(
          "connector-request",
          "connector-cleared",
          "connector-status-changed",
          "connector-connect-failed"
        ),
        (event): ConnectorsEvent | null => {
          switch (event.type) {
            case "connector-request":
              return key == null || event.request.conversationKey === key
                ? { type: "request", request: event.request }
                : null;
            case "connector-cleared":
              return { type: "cleared", requestId: event.requestId };
            case "connector-status-changed":
              return { type: "status-changed" };
            case "connector-connect-failed":
              return { type: "connect-failed", connectorId: event.connectorId };
            default:
              return null;
          }
        }
      ),
      initial: () => [
        {
          type: "snapshot",
          // Keyless: every pending ask, as the live filter passes them all.
          requests: context.deps.serviceHost.listConnectorRequests(key),
        },
      ],
      coalesceKey: (event) =>
        event.type === "status-changed" ? "status-changed" : null,
    });
  }),
});
