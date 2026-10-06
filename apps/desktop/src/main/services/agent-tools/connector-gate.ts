/**
 * The Connect cards behind `connect_connector`. A card never holds the agent:
 * the tool has already answered with a one-tap link, and the card is the
 * same hop for a user at the app. A card goes when its connector connects,
 * when its link expires, or when the user dismisses it. Every card is filed
 * under its conversation, and only that conversation can list or answer it.
 */
import type {
  ConnectorRequest,
  IpcEvent,
  RespondConnectorRequest,
} from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";

type EmitEvent = (event: IpcEvent) => void;

export class ConnectorGate {
  /** Cards on screen, keyed by request id. */
  private readonly pending = new Map<string, ConnectorRequest>();

  constructor(private readonly emitEvent: EmitEvent) {}

  /**
   * One conversation's cards. The card is fed by a one-shot event, so on
   * mount it re-reads this list to pick it up.
   */
  listPending(conversationKey?: ConversationKey): ConnectorRequest[] {
    // No key: every conversation's (a subscriber that watches them all).
    return [...this.pending.values()].filter(
      (request) =>
        conversationKey == null || request.conversationKey === conversationKey
    );
  }

  /** Put a Connect card in front of the user; one per connector per conversation. */
  show(input: {
    connectorId: string;
    label: string;
    reason?: string;
    /** The conversation that asked. See ConnectorRequest.conversationKey. */
    conversationKey: ConversationKey;
  }): void {
    for (const [requestId, request] of this.pending) {
      if (
        request.connectorId === input.connectorId &&
        request.conversationKey === input.conversationKey
      )
        this.clear(requestId);
    }
    const request: ConnectorRequest = {
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      connectorId: input.connectorId,
      label: input.label,
      conversationKey: input.conversationKey,
      ...(input.reason != null && input.reason.length > 0
        ? { reason: input.reason }
        : {}),
    };
    this.pending.set(request.requestId, request);
    this.emitEvent({
      type: "connector-request",
      request,
      emittedAt: new Date().toISOString(),
    });
  }

  /** The user answered a card (connected, dismissed, failed): it goes. */
  respond(request: RespondConnectorRequest): void {
    const shown = this.pending.get(request.requestId);
    if (shown?.conversationKey !== request.conversationKey) return;
    this.clear(request.requestId);
  }

  /** These connectors are connected now, or their links expired: every card for them goes. */
  clearFor(connectorIds: readonly string[]): void {
    for (const [requestId, request] of this.pending) {
      if (connectorIds.includes(request.connectorId)) this.clear(requestId);
    }
  }

  private clear(requestId: string): void {
    this.pending.delete(requestId);
    this.emitEvent({
      type: "connector-cleared",
      requestId,
      emittedAt: new Date().toISOString(),
    });
  }
}
