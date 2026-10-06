import type { IpcEvent } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
/**
 * The Connect card: shown without holding anything, one per connector per
 * conversation, gone once its connector connects or the user answers it, and
 * only the conversation that asked can see or answer it.
 */
import { describe, expect, it } from "vitest";

import { ConnectorGate } from "./connector-gate";

const botThread = sessionConversationKey("bots", "bot-telegram");
const otherChat = sessionConversationKey("ws-1", "session-9");

const gateWithEvents = (): { gate: ConnectorGate; events: IpcEvent[] } => {
  const events: IpcEvent[] = [];
  return { gate: new ConnectorGate((event) => events.push(event)), events };
};

const show = (
  gate: ConnectorGate,
  conversationKey = botThread,
  connectorId = "abacus-gmailuser"
): string => {
  gate.show({ connectorId, label: "Gmail", conversationKey });
  return gate.listPending(conversationKey).at(-1)!.requestId;
};

const cleared = (events: IpcEvent[]): string[] =>
  events.flatMap((event) =>
    event.type === "connector-cleared" ? [event.requestId] : []
  );

describe("a Connect card", () => {
  it("is shown without anything waiting on it", () => {
    const { gate, events } = gateWithEvents();
    const result: unknown = gate.show({
      connectorId: "abacus-gmailuser",
      label: "Gmail",
      conversationKey: botThread,
    });
    expect(result).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["connector-request"]);
  });

  it("replaces an earlier card for the same connector in the same chat", () => {
    const { gate, events } = gateWithEvents();
    const first = show(gate);
    show(gate);
    expect(cleared(events)).toEqual([first]);
    expect(gate.listPending(botThread)).toHaveLength(1);
  });

  it("goes once its connector is connected, in every chat that showed it", () => {
    const { gate, events } = gateWithEvents();
    const mine = show(gate);
    const theirs = show(gate, otherChat);
    show(gate, botThread, "abacus-slack");
    gate.clearFor(["abacus-gmailuser", "abacus-googlecalendar"]);
    expect(cleared(events).sort()).toEqual([mine, theirs].sort());
    expect(gate.listPending().map((request) => request.connectorId)).toEqual([
      "abacus-slack",
    ]);
  });

  it("goes when the user answers it", () => {
    const { gate, events } = gateWithEvents();
    const requestId = show(gate);
    gate.respond({
      requestId,
      conversationKey: botThread,
      outcome: "declined",
    });
    expect(cleared(events)).toEqual([requestId]);
    expect(gate.listPending()).toEqual([]);
  });
});

describe("the conversation a card belongs to", () => {
  it("carries the conversation that asked", () => {
    const { gate } = gateWithEvents();
    show(gate);
    expect(gate.listPending(botThread)[0]?.conversationKey).toBe(botThread);
  });

  it("is listed only to its own conversation, or to a subscriber of all", () => {
    const { gate } = gateWithEvents();
    show(gate);
    show(gate, otherChat, "abacus-slack");
    expect(gate.listPending(otherChat)).toHaveLength(1);
    expect(gate.listPending()).toHaveLength(2);
  });

  it("refuses an answer from another conversation", () => {
    const { gate, events } = gateWithEvents();
    const requestId = show(gate);
    gate.respond({
      requestId,
      conversationKey: otherChat,
      outcome: "declined",
    });
    expect(cleared(events)).toEqual([]);
    expect(gate.listPending(botThread)).toHaveLength(1);
  });
});
