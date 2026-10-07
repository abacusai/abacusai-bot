import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type {
  ConnectorOutcome,
  ConnectorRequest,
  ConnectorStatuses,
} from "../contracts";
import { mutation, query, subscription } from "./base";
import { ConversationKeySchema, NoInput } from "./ids";

export const RespondConnectorRequestSchema = v.object({
  requestId: v.pipe(v.string(), v.nonEmpty()),
  conversationKey: ConversationKeySchema,
  outcome: v.picklist(["connected", "declined", "failed"]),
  error: v.optional(v.string()),
});

const ConnectorIdInput = v.object({
  connectorId: v.pipe(v.string(), v.nonEmpty()),
});

export type ConnectorsEvent =
  /** First yield on (re)open: the asks still waiting in this conversation. */
  | { type: "snapshot"; requests: ConnectorRequest[] }
  | { type: "request"; request: ConnectorRequest }
  | { type: "cleared"; requestId: string }
  /** Something changed a connector's state: re-read `statuses`. */
  | { type: "status-changed" };

export const connectors = {
  /** Every registry connector's state on this machine, keyed by connector id. */
  statuses: query.input(NoInput).output(type<ConnectorStatuses>()),
  /**
   * A flow with no fields: a platform connector answers with its connect
   * page's `url` for the caller to open; an MCP server installs.
   */
  connect: mutation
    .input(
      v.object({
        ...ConnectorIdInput.entries,
        options: v.optional(v.object({ hint: v.optional(v.string()) })),
      })
    )
    .output(type<ConnectorOutcome>()),
  submitFields: mutation
    .input(
      v.object({
        connectorId: v.pipe(v.string(), v.nonEmpty()),
        values: v.record(v.string(), v.string()),
      })
    )
    .output(type<ConnectorOutcome>()),
  /** Nothing waits in the host any more; kept for older clients. */
  cancelConnect: mutation.input(NoInput).output(type<void>()),
  disconnect: mutation.input(ConnectorIdInput).output(type<ConnectorOutcome>()),
  /** The agent is blocked inside its tool call until this. */
  respond: mutation.input(RespondConnectorRequestSchema).output(type<void>()),
  requests: query
    .input(v.object({ conversationKey: ConversationKeySchema }))
    .output(type<ConnectorRequest[]>()),
  /**
   * Lossless-actionable. With a `conversationKey`, only that conversation's
   * asks, and the first yield is a snapshot of those still pending.
   */
  events: subscription
    .input(
      v.optional(
        v.object({ conversationKey: v.optional(ConversationKeySchema) })
      )
    )
    .output(eventIterator(type<ConnectorsEvent>())),
};
