/**
 * The Connect card: shown without holding anything, one per connector per
 * conversation, gone once its connector connects or the user answers it, and
 * only the conversation that asked can see or answer it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IpcEvent } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { afterEach, describe, expect, it } from "vitest";

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

describe("a routine's card", () => {
  const dirs: string[] = [];
  const runA = sessionConversationKey("ws-1", "run-a");
  const runB = sessionConversationKey("ws-1", "run-b");
  const chat = sessionConversationKey("ws-1", "chat");
  const record = (dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"))) => {
    dirs.push(dir);
    return {
      dir,
      file: () => path.join(dir, "connector-asks.json"),
      routineOf: (key: string) =>
        key === runA || key === runB ? "routine-1" : null,
    };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is still there after a relaunch, with its id and conversation", () => {
    const kept = record();
    const before = new ConnectorGate(() => {}, kept);
    before.show({
      connectorId: "messaging-whatsapp",
      label: "WhatsApp",
      reason: "To send the report",
      conversationKey: runA,
    });

    const events: IpcEvent[] = [];
    const after = new ConnectorGate((event) => events.push(event), kept);
    after.restore();

    expect(after.listPending(runA)).toEqual(before.listPending(runA));
    expect(events.map((event) => event.type)).toEqual(["connector-request"]);
  });

  it("leaves a chat's card out of the file", () => {
    const kept = record();
    new ConnectorGate(() => {}, kept).show({
      connectorId: "abacus-slack",
      label: "Slack",
      conversationKey: chat,
    });

    const after = new ConnectorGate(() => {}, kept);
    after.restore();

    expect(after.listPending()).toEqual([]);
  });

  it("is one per connector per routine, whichever run asked last", () => {
    const gate = new ConnectorGate(() => {}, record());
    for (const conversationKey of [runA, runB])
      gate.show({
        connectorId: "messaging-whatsapp",
        label: "WhatsApp",
        conversationKey,
      });

    expect(gate.listPending().map((card) => card.conversationKey)).toEqual([
      runB,
    ]);
  });

  it("stays gone once answered, connected or pruned", () => {
    const kept = record();
    const gate = new ConnectorGate(() => {}, kept);
    const ask = (connectorId: string) =>
      gate.show({ connectorId, label: connectorId, conversationKey: runA });
    ask("one");
    ask("two");
    ask("three");
    const [one] = gate.listPending();
    gate.respond({
      requestId: one!.requestId,
      conversationKey: runA,
      outcome: "declined",
    });
    gate.clearFor(["two"]);
    gate.prune((connectorId) => connectorId === "three");

    expect(gate.hasKept()).toBe(false);
    const after = new ConnectorGate(() => {}, kept);
    after.restore();
    expect(after.listPending()).toEqual([]);
  });

  it("treats an unreadable file as no cards", () => {
    const kept = record();
    fs.writeFileSync(kept.file(), "not json");
    const gate = new ConnectorGate(() => {}, kept);

    expect(() => gate.restore()).not.toThrow();
    expect(gate.listPending()).toEqual([]);
  });
});
