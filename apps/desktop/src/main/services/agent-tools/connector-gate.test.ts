/**
 * The Connect card's half of the round trip: what the suspended tool call is
 * told when the user answers, that it is always told something, and that
 * only the conversation that asked can see, answer, or release the ask.
 */
import { describe, expect, it, vi } from "vitest";

import type { IpcEvent } from "#shared/contracts";
import { sessionConversationKey } from "#shared/conversation-scope";

import { ConnectorGate } from "./connector-gate";

const botThread = sessionConversationKey("bots", "bot-telegram");
const otherChat = sessionConversationKey("ws-1", "session-9");

/** A gate plus the requestId of the ask it just emitted. */
const gateWith = (
  account?: string
): {
  gate: ConnectorGate;
  events: IpcEvent[];
  ask: () => Promise<string>;
  requestId: () => string;
} => {
  const events: IpcEvent[] = [];
  const gate = new ConnectorGate(
    (event) => events.push(event),
    account != null ? async () => account : undefined
  );
  return {
    gate,
    events,
    ask: () =>
      gate.ask({
        connectorId: "gmailuser",
        label: "Gmail",
        conversationKey: botThread,
      }),
    requestId: () => {
      const emitted = events.find(
        (event) => event.type === "connector-request"
      );
      if (emitted?.type !== "connector-request") throw new Error("no ask");
      return emitted.request.requestId;
    },
  };
};

describe("answering a connect ask", () => {
  /**
   * Both halves of the report this fixes. The model came back from a connect
   * knowing neither which tools it had just been given (it invented one) nor
   * whose account it had attached, so it asked the user for the Gmail address
   * on the Gmail they had connected a second earlier.
   */
  it("says who it connected as, and to use tools it can see", async () => {
    const { gate, ask, requestId } = gateWith("Gmail - ada@example.com");
    const pending = ask();

    await gate.respond({
      requestId: requestId(),
      conversationKey: botThread,
      outcome: "connected",
    });

    const outcome = await pending;
    expect(outcome).toContain("as Gmail - ada@example.com");
    expect(outcome).toContain('that account is who they mean by "me"');
    expect(outcome).toContain("never a name you have guessed at");
  });

  it("still resolves when the platform will not say who", async () => {
    const { gate, ask, requestId } = gateWith();
    const pending = ask();

    await gate.respond({
      requestId: requestId(),
      conversationKey: botThread,
      outcome: "connected",
    });

    const outcome = await pending;
    expect(outcome).toContain("Gmail is connected now.");
    expect(outcome).not.toContain("as ");
  });

  it("does not ask who, and does not stall, when the answer was no", async () => {
    const lookup = vi.fn(async () => "Gmail - ada@example.com");
    const events: IpcEvent[] = [];
    const gate = new ConnectorGate((event) => events.push(event), lookup);
    const pending = gate.ask({
      connectorId: "gmailuser",
      label: "Gmail",
      conversationKey: botThread,
    });
    const emitted = events[0];
    if (emitted?.type !== "connector-request") throw new Error("no ask");

    await gate.respond({
      requestId: emitted.request.requestId,
      conversationKey: botThread,
      outcome: "declined",
    });

    expect(await pending).toContain("did not connect Gmail");
    expect(lookup).not.toHaveBeenCalled();
  });

  /**
   * The agent is suspended inside the tool call, so a stop that does not
   * release it hangs the turn and leaves the button on screen with nothing
   * behind it.
   */
  it("releases the waiting call, and clears its card, when its turn stops", async () => {
    const { gate, events, ask, requestId } = gateWith();
    const pending = ask();
    const asked = requestId();

    gate.release(botThread, "The user stopped this turn before answering.");

    expect(await pending).toContain("stopped this turn");
    expect(
      events.some(
        (event) =>
          event.type === "connector-cleared" && event.requestId === asked
      )
    ).toBe(true);
  });
});

/**
 * Which conversation an ask belongs to, and that nothing crosses the line:
 * a bot's Connect button used to be listed, answered, and released from any
 * chat in the app, which is how it turned up in a session next door.
 */
describe("the conversation an ask belongs to", () => {
  it("carries the conversation that asked", () => {
    const events: IpcEvent[] = [];
    const gate = new ConnectorGate((event) => events.push(event));

    void gate.ask({
      connectorId: "telegram",
      label: "Telegram",
      conversationKey: botThread,
    });

    const event = events.find((entry) => entry.type === "connector-request");
    if (event?.type !== "connector-request") throw new Error("no ask");
    expect(event.request.conversationKey).toBe(botThread);
  });

  it("lists an ask only to its own conversation", () => {
    const gate = new ConnectorGate(() => undefined);
    void gate.ask({
      connectorId: "telegram",
      label: "Telegram",
      conversationKey: botThread,
    });

    expect(gate.listPending(botThread)).toHaveLength(1);
    expect(gate.listPending(otherChat)).toHaveLength(0);
  });

  it("refuses an answer from another conversation", async () => {
    const { gate, ask, requestId } = gateWith();
    const pending = ask();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await gate.respond({
      requestId: requestId(),
      conversationKey: otherChat,
      outcome: "declined",
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(gate.listPending(botThread)).toHaveLength(1);
  });

  it("releases one conversation's asks and leaves another's waiting", async () => {
    const events: IpcEvent[] = [];
    const gate = new ConnectorGate((event) => events.push(event));
    const botAsk = gate.ask({
      connectorId: "telegram",
      label: "Telegram",
      conversationKey: botThread,
    });
    void gate.ask({
      connectorId: "gmailuser",
      label: "Gmail",
      conversationKey: otherChat,
    });

    gate.release(botThread, "stopped");

    expect(await botAsk).toBe("stopped");
    expect(gate.listPending(botThread)).toHaveLength(0);
    expect(gate.listPending(otherChat)).toHaveLength(1);
  });
});
