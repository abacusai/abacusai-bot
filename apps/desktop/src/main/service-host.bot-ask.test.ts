/**
 * The main-process turn behind a request to another bot (runBotAskTurn):
 * the request goes into the asked bot's own conversation with the asker, the
 * turn's text comes back in parts, a turn that runs too long is stopped, and
 * a turn left open there is stopped before the request goes in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TimeoutError } from "@abacus-ai/contract/timeout-error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOT_ANSWER_SEGMENT,
  BOT_ASK_TURN_TIMEOUT_MS,
} from "./services/bots/bot-ask";
import type { BotAskRecord } from "./services/bots/bot-ask-service";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    { default: anything },
    {
      get: (target, property) =>
        property in target
          ? (target as Record<PropertyKey, unknown>)[property]
          : property === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});
const { ServiceHost } = await import("./service-host");

type Method = (...args: unknown[]) => unknown;
const proto = ServiceHost.prototype as unknown as Record<string, Method>;

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-ask-"));
  process.env.ABACUSAI_BOT_HOME = home;
});
afterEach(() => {
  vi.useRealTimers();
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const ASK: BotAskRecord = {
  id: "q1",
  askerId: "res",
  askerSession: "res-chat",
  targetId: "wri",
  request: "Draft a post",
  status: "running",
  attempts: 1,
  createdAt: 0,
};
const PAIR = "wri|bot:res";

/**
 * A host holding only what runBotAskTurn touches. `answer` runs when the
 * request is sent: it plays the asked bot's turn through the real waiter.
 */
const fakeHost = (
  answer: (turn: {
    say: (text: string, messageId?: string) => void;
    toolCall: () => void;
    close: (kind?: string) => void;
  }) => void = () => {},
  options: { sent?: boolean; leftOpen?: boolean } = {}
) => {
  const self: Record<string, unknown> = {
    turnWaiters: new Map(),
    botAskTurns: new Map(),
    taskTurns: new Map(),
    turnLedger: { isOpen: () => options.leftOpen === true },
    botService: {
      list: () => [{ id: "res", name: "Researcher", title: "" }],
      openSenderChat: vi.fn(async () => ({
        botId: "wri",
        workspaceId: "ws",
        sessionId: PAIR,
      })),
    },
    agentManagerService: {
      stopSession: vi.fn(),
      stopSessionAndWait: vi.fn(async () => undefined),
    },
  };
  for (const name of [
    "runBotAskTurn",
    "waitForTurn",
    "feedTurnWaiter",
    "settleTurnWaiter",
  ])
    self[name] = proto[name].bind(self);
  self.sendAgentMessage = vi.fn(
    async ({ sessionId }: { sessionId: string }) => {
      const event = (payload: Record<string, unknown>) =>
        (self.feedTurnWaiter as Method)(sessionId, {
          type: "event",
          event: payload,
        });
      answer({
        say: (content, messageId = "m1") =>
          event({ type: "text_delta", content, messageId }),
        toolCall: () => event({ type: "tool_call_start" }),
        close: (kind = "reply") =>
          (self.settleTurnWaiter as Method)({ sessionId, kind }),
      });
      return options.sent ?? true;
    }
  );
  const run = () =>
    (self.runBotAskTurn as Method)(
      ASK,
      "RULES\n\nREQUEST",
      7
    ) as Promise<string>;
  const manager = self.agentManagerService as {
    stopSession: ReturnType<typeof vi.fn>;
    stopSessionAndWait: ReturnType<typeof vi.fn>;
  };
  return { self, run, manager };
};

describe("runBotAskTurn", () => {
  it("sends the request into the asked bot's chat with the asker and returns its turn, in parts", async () => {
    const { self, run } = fakeHost((turn) => {
      turn.say("Let me look.");
      turn.toolCall();
      turn.say("<reply>Here it is.</reply>", "m2");
      turn.close();
    });
    await expect(run()).resolves.toBe(
      `Let me look.${BOT_ANSWER_SEGMENT}${BOT_ANSWER_SEGMENT}<reply>Here it is.</reply>`
    );
    expect(
      (self.botService as { openSenderChat: ReturnType<typeof vi.fn> })
        .openSenderChat
    ).toHaveBeenCalledWith("wri", "bot", "res", "Researcher");
    expect(self.sendAgentMessage).toHaveBeenCalledWith({
      workspaceId: "ws",
      sessionId: PAIR,
      message: "RULES\n\nREQUEST",
      userText: { operator: { kind: "auto-reply-intro", visibleFrom: 7 } },
    });
    expect((self.botAskTurns as Map<string, unknown>).size).toBe(0);
  });

  it("knows the running turn by request, so a cancel can stop it", async () => {
    let close = (): void => {};
    const { self, run } = fakeHost((turn) => {
      close = () => turn.close();
    });
    const pending = run();
    await vi.waitFor(() => expect(self.sendAgentMessage).toHaveBeenCalled());
    expect((self.botAskTurns as Map<string, unknown>).get("q1")).toMatchObject({
      sessionId: PAIR,
    });
    close();
    await pending;
    expect((self.botAskTurns as Map<string, unknown>).has("q1")).toBe(false);
  });

  it("stops the asked bot's turn when it runs past the limit", async () => {
    vi.useFakeTimers();
    const { self, run, manager } = fakeHost();
    const outcome = run().catch((error: unknown) => error);
    await vi.waitFor(() => expect(self.sendAgentMessage).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(BOT_ASK_TURN_TIMEOUT_MS + 1);
    const error = await outcome;
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toMatch(/so it was stopped/);
    expect(manager.stopSession).toHaveBeenCalledWith("ws", PAIR);
  });

  it("stops a turn left open in that chat before sending, so the request is not swallowed", async () => {
    const { run, manager } = fakeHost((turn) => turn.close(), {
      leftOpen: true,
    });
    await run();
    expect(manager.stopSessionAndWait).toHaveBeenCalledWith("ws", PAIR);
  });

  it("fails at once when the request could not be sent", async () => {
    const { run } = fakeHost(() => {}, { sent: false });
    await expect(run()).rejects.toThrow(/could not be started/);
  });

  it("names why when the turn ends without answering", async () => {
    const { run } = fakeHost((turn) => turn.close("failed"));
    await expect(run()).rejects.toThrow(/ended without an answer/);
  });
});

describe("where a request's answer goes", () => {
  const host = (relayed: boolean, channel: unknown = null) => {
    const self: Record<string, unknown> = {
      messagingGatewayService: { relayNote: vi.fn(() => relayed) },
      deliverSessionNote: vi.fn(),
      turnLedger: { channelOf: () => channel },
      botService: {
        list: () => [
          { id: "wri", name: "Writer", title: "", sessionId: "wri-main" },
        ],
      },
      botAskService: { get: () => null },
    };
    for (const name of ["tellBotAsk", "ownChatOfTurn", "exchangeTags"])
      self[name] = proto[name].bind(self);
    return self as {
      tellBotAsk: (ask: BotAskRecord, note: string) => void;
      ownChatOfTurn: (sessionId: string) => unknown;
      messagingGatewayService: { relayNote: ReturnType<typeof vi.fn> };
      deliverSessionNote: ReturnType<typeof vi.fn>;
    };
  };
  const WA = { platform: "whatsapp", chatId: "ME" };

  it("goes back to the user's WhatsApp chat when the request came from there", () => {
    const h = host(true);
    h.tellBotAsk({ ...ASK, channel: WA }, "NOTE");
    expect(h.messagingGatewayService.relayNote).toHaveBeenCalledWith(
      "res-chat",
      WA,
      "NOTE"
    );
    expect(h.deliverSessionNote).not.toHaveBeenCalled();
  });

  it("falls back to the app's chat when that chat is not routed here any more", () => {
    const h = host(false);
    h.tellBotAsk({ ...ASK, channel: WA }, "NOTE");
    expect(h.deliverSessionNote).toHaveBeenCalledWith(
      "res-chat",
      "NOTE",
      expect.objectContaining({
        operator: expect.objectContaining({ kind: "bot-exchange" }),
      })
    );
  });

  it("goes to the app's chat for a request made in the app", () => {
    const h = host(true);
    h.tellBotAsk(ASK, "NOTE");
    expect(h.messagingGatewayService.relayNote).not.toHaveBeenCalled();
    const tags = h.deliverSessionNote.mock.calls[0]?.[2] as {
      operator: { kind: string; exchange: Record<string, unknown> };
    };
    expect(tags.operator.kind).toBe("bot-exchange");
    // Who, what and how it ended, for the chat's row.
    expect(tags.operator.exchange).toMatchObject({
      askId: "q1",
      botId: "wri",
      bot: "Writer",
      kind: "ask",
      request: "Draft a post",
      outcome: "answered",
    });
  });

  it("remembers only the user's own chat as where a request came from, never a contact's", () => {
    expect(
      host(true, { ...WA, owner: true, userName: null }).ownChatOfTurn("s")
    ).toEqual(WA);
    expect(
      host(true, {
        platform: "whatsapp",
        chatId: "RAJ",
        owner: false,
        userName: "Raj",
      }).ownChatOfTurn("s")
    ).toBeNull();
    expect(host(true, null).ownChatOfTurn("s")).toBeNull();
  });
});

describe("a task the user gave, passed on", () => {
  const TASK: BotAskRecord = { ...ASK, id: "q8", kind: "task" };

  /** When set, the task's stop-settle wait holds until it resolves. */
  let settleGate: Promise<boolean> | null = null;
  afterEach(() => {
    settleGate = null;
  });

  const taskHost = (openTurn: boolean, ends: string | null = "reply") => {
    const closers: Array<(record: { sessionId: string }) => void> = [];
    let open = openTurn;
    const self: Record<string, unknown> = {
      turnWaiters: new Map(),
      botAskTurns: new Map(),
      taskTurns: new Map(),
      turnLedger: {
        isOpen: () => open,
        onClose: (listener: (record: { sessionId: string }) => void) => {
          closers.push(listener);
          return () => {};
        },
      },
      botService: {
        list: () => [
          { id: "res", name: "Researcher", title: "" },
          { id: "wri", name: "Writer", title: "" },
        ],
        openChat: vi.fn(async () => ({
          botId: "wri",
          workspaceId: "ws",
          sessionId: "wri-main",
        })),
        openSenderChat: vi.fn(),
      },
      agentManagerService: {
        stopSession: vi.fn(),
        stopSessionAndWait: vi.fn(),
      },
      // The task's status as the service holds it; tests set "cancelled".
      botAskService: { get: vi.fn(() => null) },
      sessionTurnStateService: {
        stopSettled: vi.fn(() => settleGate ?? Promise.resolve(true)),
      },
      userWords: new Map(),
      taskFollowUps: new Map(),
      agentSessionManagerService: {
        getDiagnosticInfo: () => ({
          agentSessionFile: path.join(home, "wri-main.jsonl"),
        }),
      },
      tellBotAsk: vi.fn(),
    };
    for (const name of [
      "runBotAskTurn",
      "turnClosed",
      "waitForTurn",
      "feedTurnWaiter",
      "settleTurnWaiter",
      "userSteppedIn",
      "noteUserWords",
      "watchTaskFollowUp",
      "replyTo",
      "transcriptFile",
      "transcriptSize",
    ])
      self[name] = proto[name].bind(self);
    // As the user's Stop: the turn ends stopped.
    self.stopAgentTurn = vi.fn(({ sessionId }: { sessionId: string }) =>
      (self.settleTurnWaiter as Method)({ sessionId, kind: "stopped" })
    );
    self.sendAgentMessage = vi.fn(
      async ({ sessionId }: { sessionId: string }) => {
        (self.feedTurnWaiter as Method)(sessionId, {
          type: "event",
          event: { type: "text_delta", content: "Posted.", messageId: "m1" },
        });
        if (ends != null)
          (self.settleTurnWaiter as Method)({ sessionId, kind: ends });
        return true;
      }
    );
    const endUserTurn = () => {
      open = false;
      for (const close of closers) close({ sessionId: "wri-main" });
    };
    return { self, endUserTurn };
  };

  /** Writer's chat log as the transcript reader finds it. */
  const chatLog = (...turns: Array<[string, string]>) =>
    fs.writeFileSync(
      path.join(home, "wri-main.jsonl"),
      turns
        .map(([role, content]) =>
          JSON.stringify({ message: { role, content } })
        )
        .join("\n")
    );

  it("after it ends, the user's next words there and the answer go to the bot that passed it on, once", async () => {
    const { self, endUserTurn } = taskHost(false);
    await (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    (self.noteUserWords as Method)(
      "wri-main",
      "forget that, we launch in January"
    );
    chatLog(
      ["user", "forget that, we launch in January"],
      ["assistant", "Dropped the post. Ping me in January."]
    );
    endUserTurn();
    const tell = self.tellBotAsk as ReturnType<typeof vi.fn>;
    expect(tell).toHaveBeenCalledTimes(1);
    const [ask, note] = tell.mock.calls[0] as [BotAskRecord, string];
    expect(ask.id).toBe("q8");
    expect(note).toContain(
      'the user wrote to Writer in its chat: "forget that, we launch in January"'
    );
    expect(note).toContain("Dropped the post. Ping me in January.");
    expect(note).toContain("reply exactly NO_REPLY");
    (self.noteUserWords as Method)("wri-main", "and a tagline please");
    endUserTurn();
    expect(tell).toHaveBeenCalledTimes(1);
  });

  it("matches the user's whole message, and drops a NO_REPLY from the answer", async () => {
    const { self, endUserTurn } = taskHost(false);
    await (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    (self.noteUserWords as Method)("wri-main", "ok");
    chatLog(
      ["user", "ok, make it shorter"],
      ["assistant", "Shorter."],
      ["user", "ok"],
      ["assistant", "NO_REPLY Noted, nothing to add."]
    );
    endUserTurn();
    const note = (self.tellBotAsk as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(note).toContain("Noted, nothing to add.");
    expect(note).not.toContain("Shorter.");
    expect(note).not.toContain("NO_REPLY\n");
  });

  it("finds the user's message under a long reply, past the usual tail", async () => {
    const { self, endUserTurn } = taskHost(false);
    await (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    (self.noteUserWords as Method)("wri-main", "go ahead and finish it");
    chatLog(
      ["user", "go ahead and finish it"],
      ...Array.from({ length: 40 }, (): [string, string] => [
        "assistant",
        "x".repeat(10_000),
      ]),
      ["assistant", "Done, saved."]
    );
    endUserTurn();
    const note = (self.tellBotAsk as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(note).toContain("Done, saved.");
  });

  it("a cancel while the stop before it settles: never sent", async () => {
    let release = (): void => {};
    settleGate = new Promise((resolve) => {
      release = () => resolve(true);
    });
    const { self } = taskHost(false);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    (self.taskTurns as Map<string, { cancelled: boolean }>).get(
      "q8"
    )!.cancelled = true;
    release();
    await expect(pending).rejects.toThrow(/cancelled before it began/);
    expect(self.sendAgentMessage).not.toHaveBeenCalled();
    expect(self.tellBotAsk).not.toHaveBeenCalled();
  });

  it("a follow-up the user sent from a chat app, with its label, still matches", async () => {
    const { self, endUserTurn } = taskHost(false);
    await (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    (self.noteUserWords as Method)(
      "wri-main",
      "[WhatsApp message from Sam] forget that, we launch in January"
    );
    chatLog(
      ["user", "[WhatsApp message from Sam] forget that, we launch in January"],
      ["assistant", "Dropped. Ping me in January."]
    );
    endUserTurn();
    const note = (self.tellBotAsk as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(note).toContain("Dropped. Ping me in January.");
  });

  it("no follow-up for a bot the user deleted meanwhile", async () => {
    const { self, endUserTurn } = taskHost(false);
    (self.botService as { list: () => unknown[] }).list = () => [
      { id: "res", name: "Researcher", title: "" },
    ];
    await (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    (self.noteUserWords as Method)("wri-main", "anything");
    chatLog(["user", "anything"], ["assistant", "Sure."]);
    endUserTurn();
    expect(self.tellBotAsk).not.toHaveBeenCalled();
    expect((self.taskFollowUps as Map<string, unknown>).size).toBe(0);
  });

  it("the same words sent twice step in on either copy", async () => {
    const { self } = taskHost(false, null);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await vi.waitFor(() =>
      expect(
        (self.taskTurns as Map<string, { sent: boolean }>).get("q8")?.sent
      ).toBe(true)
    );
    (self.noteUserWords as Method)("wri-main", "stop");
    await expect(pending).rejects.toThrow(/partway through/);
    const again = (self.runBotAskTurn as Method)(
      { ...TASK, id: "q9" },
      "TASK PROMPT",
      null
    );
    await vi.waitFor(() =>
      expect(
        (self.taskTurns as Map<string, { sent: boolean }>).get("q9")?.sent
      ).toBe(true)
    );
    // The identical text again: deduped as words, still a step-in.
    (self.noteUserWords as Method)("wri-main", "stop");
    await expect(again).rejects.toThrow(/partway through/);
  });

  it("waits for the turn that answers the user, not one that closes before it", async () => {
    const { self, endUserTurn } = taskHost(false);
    await (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    (self.noteUserWords as Method)("wri-main", "make it shorter");
    chatLog(["user", "something earlier"], ["assistant", "Earlier answer."]);
    endUserTurn();
    expect(self.tellBotAsk).not.toHaveBeenCalled();
    chatLog(["user", "make it shorter"], ["assistant", "Shorter version."]);
    endUserTurn();
    expect(self.tellBotAsk).toHaveBeenCalledTimes(1);
  });

  it("the user who stepped in: their words and the answer that follows go on too", async () => {
    const { self, endUserTurn } = taskHost(false, null);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await vi.waitFor(() =>
      expect(
        (self.taskTurns as Map<string, { sent: boolean }>).get("q8")?.sent
      ).toBe(true)
    );
    (self.noteUserWords as Method)("wri-main", "make it 3 days, not 7");
    await expect(pending).rejects.toThrow(/partway through/);
    chatLog(
      ["user", "make it 3 days, not 7"],
      ["assistant", "Shortened to 3 days."]
    );
    endUserTurn();
    expect(
      (self.tellBotAsk as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
    ).toContain("Shortened to 3 days.");
  });

  it("a cancelled task has no follow-up", async () => {
    const { self, endUserTurn } = taskHost(false);
    (
      self.botAskService as { get: ReturnType<typeof vi.fn> }
    ).get.mockReturnValue({ ...TASK, status: "cancelled" });
    await (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    (self.noteUserWords as Method)("wri-main", "anything");
    chatLog(["user", "anything"], ["assistant", "Sure."]);
    endUserTurn();
    expect(self.tellBotAsk).not.toHaveBeenCalled();
  });

  it("tells the bot that passed it on when the user stopped it partway", async () => {
    const { self } = taskHost(false, "stopped");
    await expect(
      (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null)
    ).rejects.toThrow(
      /the user stopped it partway through, so it may be half done/
    );
  });

  it("runs in the doing bot's own chat, shown as it arrived", async () => {
    const { self } = taskHost(false);
    await expect(
      (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null)
    ).resolves.toBe("Posted.");
    expect(
      (self.botService as { openChat: ReturnType<typeof vi.fn> }).openChat
    ).toHaveBeenCalledWith("wri");
    expect(self.sendAgentMessage).toHaveBeenCalledWith({
      workspaceId: "ws",
      sessionId: "wri-main",
      message: "TASK PROMPT",
    });
  });

  it("waits for the user's own turn in that chat to end, never steering into it", async () => {
    const { self, endUserTurn } = taskHost(true);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(self.sendAgentMessage).not.toHaveBeenCalled();
    endUserTurn();
    await expect(pending).resolves.toBe("Posted.");
  });

  it("stops when the user writes in that chat partway, and tells the passer what they wrote", async () => {
    const { self } = taskHost(false, null);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await vi.waitFor(() =>
      expect(
        (self.taskTurns as Map<string, { sent: boolean }>).get("q8")?.sent
      ).toBe(true)
    );
    (self.userSteppedIn as Method)("wri-main", "stop that, do the menu");
    await expect(pending).rejects.toThrow(
      /wrote to it in its own chat partway through.*What they wrote: "stop that, do the menu"/
    );
    expect(self.stopAgentTurn).toHaveBeenCalledWith({
      botId: "wri",
      workspaceId: "ws",
      sessionId: "wri-main",
    });
    expect((self.taskTurns as Map<string, unknown>).size).toBe(0);
  });

  it("is not stopped by the user's message while it only waits for their turn to end", async () => {
    const { self, endUserTurn } = taskHost(true);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    (self.userSteppedIn as Method)("wri-main", "and one more thing");
    expect(self.stopAgentTurn).not.toHaveBeenCalled();
    endUserTurn();
    await expect(pending).resolves.toBe("Posted.");
  });

  it("cancelled while it waits for the user's own turn: that turn goes on, and the task never goes in", async () => {
    const { self, endUserTurn } = taskHost(true);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    (self.taskTurns as Map<string, { cancelled: boolean }>).get(
      "q8"
    )!.cancelled = true;
    endUserTurn();
    await expect(pending).rejects.toThrow(/cancelled before it began/);
    expect(self.sendAgentMessage).not.toHaveBeenCalled();
    expect(self.stopAgentTurn).not.toHaveBeenCalled();
  });

  const wordsHost = () => {
    const self: Record<string, unknown> = {
      userWords: new Map(),
      taskFollowUps: new Map(),
      botAskService: { ask: vi.fn(() => ({ ask: TASK, behind: 0 })) },
      botService: {
        list: () => [
          { id: "res", name: "Researcher" },
          { id: "wri", name: "Writer" },
          { id: "pla", name: "Planner" },
        ],
      },
      turnLedger: { channelOf: () => null },
      botAskTurns: new Map(),
      taskTurns: new Map(),
    };
    for (const name of [
      "userSteppedIn",
      "noteUserWords",
      "latestUserWords",
      "askBot",
      "giveBotTask",
      "ownChatOfTurn",
    ])
      self[name] = proto[name].bind(self);
    return self as {
      noteUserWords: (
        sessionId: string,
        message: string,
        tags?: unknown
      ) => void;
      giveBotTask: (...args: string[]) => unknown;
      askBot: (...args: string[]) => unknown;
      userWords: Map<string, Array<{ text: string; at: number }>>;
      botAskService: { ask: ReturnType<typeof vi.fn> };
    };
  };
  const refused = {
    error: expect.stringContaining(
      "pass a task on only while answering the user"
    ),
  };
  const handOffRefused = {
    error: expect.stringContaining("did not ask to hand this off"),
  };
  const wordsGiven = (h: ReturnType<typeof wordsHost>) =>
    (h.botAskService.ask.mock.calls.at(-1)?.[4] as { userWords?: string })
      ?.userWords;
  const tryTask = (...messages: string[]) => {
    const h = wordsHost();
    for (const message of messages) h.noteUserWords("res-chat", message);
    return { h, result: h.giveBotTask("res", "res-chat", "pla", "Draft it") };
  };

  describe("a question to another bot", () => {
    const tryAsk = (...messages: string[]) => {
      const h = wordsHost();
      for (const message of messages) h.noteUserWords("res-chat", message);
      return {
        h,
        result: h.askBot("res", "res-chat", "wri", "a tagline please"),
      };
    };

    it("goes out when the user asks for it, naming the bot or not", () => {
      for (const words of [
        "ask Writer for a tagline",
        "check with someone for a tagline",
      ]) {
        const { h } = tryAsk(words);
        expect(h.botAskService.ask).toHaveBeenCalledTimes(1);
      }
    });

    it("goes out when the user misspells the bot they ask for", () => {
      for (const words of ["Ask Wrtier for a tagline", "ping writr please"]) {
        const { h } = tryAsk(words);
        expect(h.botAskService.ask).toHaveBeenCalledTimes(1);
      }
    });

    it("says when the user asked for a bot they do not have, and that nothing went out", () => {
      const { h, result } = tryAsk("Ask Marketer to plan our campaign");
      expect(result).toEqual({
        error: expect.stringMatching(
          /"Marketer", which is not one of their bots\. Nothing was sent/
        ),
      });
      expect(h.botAskService.ask).not.toHaveBeenCalled();
    });

    it("a near-miss word elsewhere does not name a bot", () => {
      const { h, result } = tryAsk(
        "I need a tagline like the ones writers use"
      );
      expect(result).toEqual({
        error: expect.stringContaining("did not ask you to ask another bot"),
      });
      expect(h.botAskService.ask).not.toHaveBeenCalled();
    });

    it("goes out when the user says yes to the bot's offer", () => {
      const { h } = tryAsk("I need a tagline for Brewly", "yes please");
      expect(h.botAskService.ask).toHaveBeenCalledTimes(1);
    });

    it("goes out on a plain yes alone: the bot offered on a turn that was not the user's", () => {
      const h = wordsHost();
      h.noteUserWords("res-chat", "[first run] Introduce yourself…", {
        systemReminder: true,
        operator: { kind: "environment-notice" },
      });
      h.noteUserWords("res-chat", "yes");
      h.askBot("res", "res-chat", "wri", "a tagline please");
      expect(h.botAskService.ask).toHaveBeenCalledTimes(1);
    });

    it("never on the bot's own initiative: it answers itself or offers", () => {
      const { h, result } = tryAsk("I need a tagline for Brewly");
      expect(result).toEqual({
        error: expect.stringContaining("did not ask you to ask another bot"),
      });
      expect(h.botAskService.ask).not.toHaveBeenCalled();
    });

    it("only the bot the user named", () => {
      const { result } = tryAsk("ask Planner what day works");
      expect(result).toEqual({
        error: expect.stringContaining("asked for Planner, not Writer"),
      });
    });

    it("never from a turn a bot's answer started: no loops", () => {
      const h = wordsHost();
      h.noteUserWords("res-chat", "ask Writer for a tagline");
      h.noteUserWords("res-chat", "[bot answer] Writer answered…", {
        systemReminder: true,
        operator: { kind: "environment-notice" },
      });
      expect(h.askBot("res", "res-chat", "wri", "another one")).toEqual({
        error: expect.stringContaining("only while answering the user"),
      });
      expect(h.botAskService.ask).not.toHaveBeenCalled();
    });
  });

  it("is refused when the user said nothing", () => {
    expect(tryTask().result).toEqual(refused);
  });

  it("is refused once a hidden note starts a turn: the app's words are not the user's", () => {
    const { h } = tryTask("have Planner draft the checklist");
    h.noteUserWords("res-chat", "[bot answer] Writer answered…", {
      systemReminder: true,
      operator: { kind: "environment-notice" },
    });
    expect(h.giveBotTask("res", "res-chat", "pla", "post it")).toEqual(refused);
  });

  it("is refused for a request made to the bot itself", () => {
    expect(
      tryTask("Also get a 5-step launch checklist made for Nov 20").result
    ).toEqual(handOffRefused);
    expect(tryTask("I need a catchy tagline").result).toEqual(handOffRefused);
  });

  it("is allowed when the latest message names a bot or asks for someone else", () => {
    expect(
      tryTask("get Planner to do the launch checklist").result
    ).not.toEqual(handOffRefused);
    expect(tryTask("have someone draft a launch post").result).not.toEqual(
      handOffRefused
    );
    expect(tryTask("hand this off to the team").result).not.toEqual(
      handOffRefused
    );
  });

  it("goes only to the bot the user named", () => {
    expect(tryTask("ask Writer to draft the launch post").result).toEqual({
      error: expect.stringContaining("asked for Writer, not Planner"),
    });
    expect(
      tryTask("have Writer or Planner sort the schedule").result
    ).not.toEqual(expect.objectContaining({ error: expect.anything() }));
  });

  it("is refused when the user only mentions a team or someone", () => {
    for (const words of [
      "Budget is 50,000 rupees; the team is me plus two ambassadors.",
      "Someone told me cafés open at 8, plan the stall around that",
    ])
      expect(tryTask(words).result).toEqual(handOffRefused);
  });

  it("is allowed when the user asks for help from someone or the team", () => {
    for (const words of [
      "Get the team on the launch plan",
      "Can someone check the landing page copy?",
      "we need someone to draft the checklist",
      "loop in another bot for the schedule",
    ])
      expect(tryTask(words).result).not.toEqual(handOffRefused);
  });

  it("is refused when a word only looks like a bot's name", () => {
    expect(
      tryTask("we planned the launch, make me a checklist").result
    ).toEqual(handOffRefused);
    expect(tryTask("have Plannr draft the checklist").result).not.toEqual(
      handOffRefused
    );
  });

  it("judges the latest message only: an earlier hand-off does not cover a new request", () => {
    expect(
      tryTask("have Planner draft the checklist", "now make me a launch post")
        .result
    ).toEqual(handOffRefused);
  });

  it("carries only the latest message, not the chat before it", () => {
    const { h } = tryTask(
      "we are launching Brewly",
      "our users are students",
      "have Planner draft the launch checklist for Nov 20"
    );
    expect(wordsGiven(h)).toBe(
      "have Planner draft the launch checklist for Nov 20"
    );
  });

  it("a task needs more than a plain yes: its words say what the work is", () => {
    expect(tryTask("yes").result).toEqual(handOffRefused);
  });

  it("a plain yes to the bot's offer carries the message before it", () => {
    const { h, result } = tryTask(
      "make a launch checklist for Nov 20",
      "yes go ahead"
    );
    expect(result).not.toEqual(handOffRefused);
    expect(wordsGiven(h)).toBe(
      "make a launch checklist for Nov 20\nyes go ahead"
    );
    const whatsapp = tryTask(
      "[WhatsApp message from @me] make a launch checklist",
      "[WhatsApp message from @me] ok do it"
    );
    expect(whatsapp.result).not.toEqual(handOffRefused);
  });

  it("counts a message once when it arrives by both paths", () => {
    const { h } = tryTask("make a checklist", "yes", "yes");
    expect(h.userWords.get("res-chat")?.map((entry) => entry.text)).toEqual([
      "make a checklist",
      "yes",
    ]);
  });

  it("forgets words older than 15 minutes", () => {
    const { h } = tryTask("have Planner draft the checklist");
    h.userWords.get("res-chat")![0].at -= 16 * 60_000;
    expect(h.giveBotTask("res", "res-chat", "pla", "Draft it")).toEqual(
      refused
    );
  });

  it("a yes taken back in the same breath is not a yes", () => {
    for (const said of [
      "ok but actually no, you do it",
      "okay never mind",
      "sure, forget it",
      "yeah, cancel that",
      "はい、やめてください",
    ]) {
      const h = wordsHost();
      h.noteUserWords("res-chat", said);
      expect(h.askBot("res", "res-chat", "wri", "Draft it")).toEqual(
        expect.objectContaining({ error: expect.any(String) })
      );
    }
  });

  it("a yes with a harmless tail is still a yes", () => {
    for (const said of [
      "ok no problem",
      "sure, hold on",
      "yes, not a problem",
    ]) {
      const h = wordsHost();
      h.noteUserWords("res-chat", "Writer could draft it. Want me to ask?");
      h.noteUserWords("res-chat", said);
      expect(h.askBot("res", "res-chat", "wri", "Draft it")).not.toHaveProperty(
        "error"
      );
    }
  });

  it("a yes in the app's other languages counts", () => {
    for (const said of [
      "sí, adelante",
      "ja, mach das",
      "oui",
      "はい、お願いします",
      "네",
      "evet tamam",
    ]) {
      const h = wordsHost();
      h.noteUserWords("res-chat", "Writer could draft it. Want me to ask?");
      h.noteUserWords("res-chat", said);
      expect(h.askBot("res", "res-chat", "wri", "Draft it")).not.toHaveProperty(
        "error"
      );
    }
  });

  it("a passed-on task clears the user's earlier words there: nothing in its turn can pass work on", () => {
    const h = wordsHost();
    h.noteUserWords("res-chat", "ask Writer for a tagline");
    h.noteUserWords(
      "res-chat",
      "[task from the user, passed on by Planner] Make a list"
    );
    expect(h.askBot("res", "res-chat", "wri", "Draft it")).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("not started by them"),
      })
    );
  });

  it("never counts a passed-on task as the user's words, so it cannot be passed on again", () => {
    const h = wordsHost();
    h.noteUserWords(
      "wri-main",
      "[task from the user, passed on by Researcher] The user asked…"
    );
    expect(h.userWords.has("wri-main")).toBe(false);
  });
});
