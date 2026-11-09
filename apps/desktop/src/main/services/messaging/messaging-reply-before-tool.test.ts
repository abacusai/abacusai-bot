import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * A reply the model wrapped before a tool call is still the reply.
 *
 * Text before a tool call is treated as narration and dropped, which is
 * right for "Let me check the weather", but a model that answered "Love
 * you too" inside <reply>, then filed a memory note, ended its turn with
 * nothing after the tool call, and the wrapped answer went with the
 * narration. Nothing was sent, and nothing was logged as failed.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: "ws",
    }),
    isPlatformEnabled: (id: MessagingPlatformId) => id === "discord",
    isPlatformConfigured: (id: MessagingPlatformId) => id === "discord",
    approvedUserIds: () => new Set(["U1"]),
    findPairing: () => null,
    recordPairingRequest: () => {},
    listPairing: () => [],
    readStoredMessageLog: () => [],
    writeStoredMessageLog: () => {},
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { gatewayTurns } = await import("./messaging-turns.test-support");

const harness = () => {
  const sent: string[] = [];
  let currentSession = "";
  let created = 0;
  const turns = gatewayTurns(() => gateway);
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      created += 1;
      currentSession = `session-${created}`;
      return { id: currentSession } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (_w: string, s: string) => turns.sent(s),
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "discord",
    {
      id: "discord",
      start: async () => {},
      stop: async () => {},
      sendText: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    }
  );
  // Failure lines the gateway starts (an empty reply's included), counted here.
  const failures: unknown[] = [];
  (
    gateway as unknown as {
      startFailureReply: (r: unknown, f: unknown) => void;
    }
  ).startFailureReply = (_route, failure) => {
    failures.push(failure);
  };
  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };
  const emit = (event: Record<string, unknown>): void =>
    turns.emit(currentSession, event);
  return {
    sent,
    failures,
    inbound: (text: string) =>
      internals.handleInbound("discord", {
        userId: "U1",
        userName: "S",
        chatId: "C1",
        text,
      }),
    say: (content: string, messageId?: string) =>
      emit({ type: "text_delta", content, messageId }),
    tool: (toolName = "memory") => emit({ type: "tool_call_start", toolName }),
    recovery: () => emit({ type: "promised_work_recovery", model: "m" }),
    settled: (text: string) =>
      emit({ type: "turn_answer", messageIds: [], text, settled: true }),
    idle: () => emit({ type: "status_changed", status: AgentStatus.Idle }),
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a reply wrapped before a tool call", () => {
  it("is sent when the turn ends with nothing after the call", async () => {
    const h = harness();
    await h.inbound("Love u");
    h.say("A warm message. <reply>Love you too ❤️</reply>", "m1");
    h.tool();
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Love you too ❤️"]);
  });

  it("gives way to a reply written after the call", async () => {
    const h = harness();
    await h.inbound("weather?");
    h.say("<reply>one sec</reply>", "m1");
    h.tool();
    h.say("<reply>Sunny, 24°.</reply>", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Sunny, 24°."]);
  });

  it("still drops untagged narration before a call", async () => {
    const h = harness();
    await h.inbound("weather?");
    h.say("Let me check the weather for you.", "m1");
    h.tool();
    h.say("<reply>Sunny, 24°.</reply>", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Sunny, 24°."]);
  });

  it("is the reply when that call is suggest_tasks, which can end the turn", async () => {
    const h = harness();
    await h.inbound("hi");
    h.say("Hi! What should we start with?", "m1");
    h.tool("suggest_tasks");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Hi! What should we start with?"]);
  });

  it("gives way to the next message when suggest_tasks did not end the turn", async () => {
    const h = harness();
    await h.inbound("hi");
    h.say("Hi!", "m1");
    h.tool("suggest_tasks");
    h.say("Hi! What should we start with?", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Hi! What should we start with?"]);
  });

  it("does not carry a reply into the next turn", async () => {
    const h = harness();
    await h.inbound("Love u");
    h.say("<reply>Love you too</reply>", "m1");
    h.tool();
    h.idle();
    await tick();
    await h.inbound("ok");
    h.say("Noted.", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(["Love you too", "Noted."]);
  });
});

describe("a turn the model was told to go on with", () => {
  const report = `Here is the full report. ${"Row by row. ".repeat(40)}Reading the rest now.`;

  it.each([
    [
      "sends only the last words after a bare promise",
      "Reading them now.",
      "All 3 are done.",
      ["All 3 are done."],
    ],
    [
      "sends a report and the last words as one message",
      report,
      "All 3 are done.",
      [`${report}\n\nAll 3 are done.`],
    ],
    [
      "keeps the promise when nothing follows it",
      "Reading them now.",
      "",
      ["Reading them now."],
    ],
    [
      "treats a wrapped promise like a bare one",
      "<reply>One sec</reply>",
      "All 3 are done.",
      ["All 3 are done."],
    ],
  ])("%s", async (_name, promise, last, sent) => {
    const h = harness();
    await h.inbound("read them");
    h.say(promise, "m1");
    h.recovery();
    h.tool();
    if (last.length > 0) h.say(last, "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual(sent);
  });

  it("does not carry held words into the next turn", async () => {
    const h = harness();
    await h.inbound("read them");
    h.say(report, "m1");
    h.recovery();
    h.idle();
    await tick();
    await h.inbound("ok");
    h.say("Noted.", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual([report, "Noted."]);
  });
});

describe("a reply sent before the turn closes (settled turn_answer)", () => {
  const WORDS = "Section 1 is fixed. Moving into section 2 next.";

  it("goes out at once, and the close owes nothing more", async () => {
    const h = harness();
    await h.inbound("fix both sections");
    h.say(WORDS, "m1");
    h.settled(WORDS);
    await tick();
    expect(h.sent).toEqual([WORDS]);
    h.idle();
    await tick();
    expect(h.sent).toEqual([WORDS]);
    expect(h.failures).toEqual([]);
  });

  it("still gets the empty-reply line when it carried no words", async () => {
    const h = harness();
    await h.inbound("fix both sections");
    h.settled("");
    h.idle();
    await tick();
    expect(h.sent).toEqual([]);
    expect(h.failures).toHaveLength(1);
  });

  it("is followed by what the steered work reports, once", async () => {
    const h = harness();
    await h.inbound("fix both sections");
    h.say(WORDS, "m1");
    h.settled(WORDS);
    h.recovery();
    h.tool("edit");
    h.say("Both sections are fixed.", "m2");
    h.idle();
    await tick();
    expect(h.sent).toEqual([WORDS, "Both sections are fixed."]);
    expect(h.failures).toEqual([]);
  });
});
