/**
 * The Connect cards behind `connect_connector`. A card never holds the agent:
 * the tool has already answered with a one-tap link, and the card is the
 * same hop for a user at the app. A card goes when its connector connects
 * or when the user dismisses it. When its link expires it stays, marked
 * expired, and its Connect button gets a new link. Every card is filed
 * under its conversation, and only that conversation can list or answer it.
 * A routine's run has nobody in front of it, so its card is the one thing
 * left for the user to find: it is kept on disk across a relaunch, and a
 * later run's ask for the same connector replaces it.
 */
import fs from "node:fs";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import type {
  ConnectorRequest,
  IpcEvent,
  RespondConnectorRequest,
} from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";

type EmitEvent = (event: IpcEvent) => void;

/** Where routines' cards are kept, and whose they are. */
export interface ConnectorGateRecord {
  file: () => string;
  /** The routine a conversation is a run of, or null. */
  routineOf: (conversationKey: ConversationKey) => string | null;
}

/** A card as kept on disk: the routine rides along for a later run's ask. */
type KeptRequest = ConnectorRequest & { routineId: string };

const isKept = (value: unknown): value is KeptRequest => {
  const card = value as Partial<KeptRequest> | null;
  return (
    typeof card?.requestId === "string" &&
    typeof card.connectorId === "string" &&
    typeof card.label === "string" &&
    typeof card.conversationKey === "string" &&
    typeof card.routineId === "string"
  );
};

export class ConnectorGate {
  /** Cards on screen, keyed by request id. */
  private readonly pending = new Map<string, ConnectorRequest>();
  /** The routine behind a card, for those that outlive the app. */
  private readonly routines = new Map<string, string>();

  constructor(
    private readonly emitEvent: EmitEvent,
    private readonly record: ConnectorGateRecord | null = null
  ) {}

  /** Puts back the cards the last launch kept; an unreadable file is none. */
  restore(): void {
    if (this.record == null) return;
    let kept: unknown;
    try {
      kept = JSON.parse(fs.readFileSync(this.record.file(), "utf8"));
    } catch {
      // Absent until a routine first asks.
      return;
    }
    for (const card of Array.isArray(kept) ? kept.filter(isKept) : []) {
      const { routineId, ...request } = card;
      if (this.pending.has(request.requestId)) continue;
      this.pending.set(request.requestId, request);
      this.routines.set(request.requestId, routineId);
      this.emitEvent({
        type: "connector-request",
        request,
        emittedAt: new Date().toISOString(),
      });
    }
  }

  /** Whether any card here outlives the app. */
  hasKept(): boolean {
    return this.routines.size > 0;
  }

  /** Clears the kept cards `stale` says have gone by: no one else will. */
  prune(stale: (connectorId: string, routineId: string) => boolean): void {
    for (const [requestId, routineId] of this.routines) {
      const request = this.pending.get(requestId);
      if (request != null && stale(request.connectorId, routineId))
        this.clear(requestId);
    }
  }

  private save(): void {
    const record = this.record;
    if (record == null) return;
    const kept = [...this.pending.values()].flatMap((request) => {
      const routineId = this.routines.get(request.requestId);
      return routineId == null ? [] : [{ ...request, routineId }];
    });
    try {
      writeFileAtomicSync(record.file(), `${JSON.stringify(kept, null, 2)}\n`);
    } catch (error) {
      // The card is still on screen; only a relaunch would lose it.
      console.warn("[connectors] could not keep a routine's card:", error);
    }
  }

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
    /** When the link it came with stops working (ms). */
    expiresAt?: number;
    /** The conversation that asked. See ConnectorRequest.conversationKey. */
    conversationKey: ConversationKey;
  }): void {
    const routineId = this.record?.routineOf(input.conversationKey) ?? null;
    for (const [requestId, request] of this.pending) {
      if (
        request.connectorId === input.connectorId &&
        (request.conversationKey === input.conversationKey ||
          (routineId != null && this.routines.get(requestId) === routineId))
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
      ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
    };
    this.pending.set(request.requestId, request);
    if (routineId != null) {
      this.routines.set(request.requestId, routineId);
      this.save();
    }
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

  /** These connectors are connected now: every card for them goes. */
  clearFor(connectorIds: readonly string[]): void {
    for (const [requestId, request] of this.pending) {
      if (connectorIds.includes(request.connectorId)) this.clear(requestId);
    }
  }

  /**
   * An offer for these connectors expired unconnected. A card that came with
   * a link stays, marked expired, unless a newer link of its own is still
   * live; one with no link behind it goes, as there is nothing to renew.
   */
  expire(connectorIds: readonly string[], linked: boolean, now: number): void {
    for (const [requestId, request] of this.pending) {
      if (!connectorIds.includes(request.connectorId)) continue;
      if (!linked) this.clear(requestId);
      else if (
        request.expired !== true &&
        (request.expiresAt == null || request.expiresAt <= now)
      )
        this.update({ ...request, expired: true });
    }
  }

  /** A fresh link went out for this connector: its cards count down from it again. */
  renew(connectorId: string, expiresAt: number | undefined): void {
    for (const request of this.pending.values()) {
      if (request.connectorId !== connectorId) continue;
      const { expired: _expired, expiresAt: _was, ...rest } = request;
      this.update({ ...rest, ...(expiresAt != null ? { expiresAt } : {}) });
    }
  }

  /** The same card, changed: kept on disk when it is a routine's, and shown again. */
  private update(request: ConnectorRequest): void {
    this.pending.set(request.requestId, request);
    if (this.routines.has(request.requestId)) this.save();
    this.emitEvent({
      type: "connector-request",
      request,
      emittedAt: new Date().toISOString(),
    });
  }

  private clear(requestId: string): void {
    this.pending.delete(requestId);
    if (this.routines.delete(requestId)) this.save();
    this.emitEvent({
      type: "connector-cleared",
      requestId,
      emittedAt: new Date().toISOString(),
    });
  }
}
