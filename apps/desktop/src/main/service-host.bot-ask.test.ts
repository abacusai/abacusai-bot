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
import { ConnectivityService } from "./services/connectivity/connectivity-service";

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
    // Turn waits are timed in awake time (the power clock).
    connectivity: new ConnectivityService({ probe: async () => true }),
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
    "taskTag",
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
      taskRounds: new Map(),
    };
    for (const name of [
      "tellBotAsk",
      "withRounds",
      "ownChatOfTurn",
      "exchangeTags",
    ])
      self[name] = proto[name].bind(self);
    return self as {
      tellBotAsk: (ask: BotAskRecord, note: string) => void;
      ownChatOfTurn: (sessionId: string) => unknown;
      messagingGatewayService: { relayNote: ReturnType<typeof vi.fn> };
      deliverSessionNote: ReturnType<typeof vi.fn>;
    };
  };
  const WA = { platform: "whatsapp", chatId: "ME" };
  const TASK_ASK: BotAskRecord = { ...ASK, kind: "task", status: "answered" };

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

  it("a follow-up (the user's next words in the doer's chat) goes in hidden: no row", () => {
    const h = host(true) as ReturnType<typeof host> & {
      tellBotAsk: (
        ask: BotAskRecord,
        note: string,
        extra: { userWords?: string }
      ) => void;
    };
    h.tellBotAsk(TASK_ASK, "FOLLOW-UP", {
      userWords: "can you open a browser",
    });
    expect(h.deliverSessionNote).toHaveBeenCalledWith(
      "res-chat",
      "FOLLOW-UP",
      undefined
    );
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

describe("an answer the asker already read", () => {
  const exchange = (askId: string, outcome = "answered") => ({
    systemReminder: true,
    operator: {
      kind: "bot-exchange",
      exchange: { askId, botId: "wri", bot: "Writer", kind: "ask", outcome },
    },
  });
  const host = (held: Array<{ note: string; tags?: unknown }>) => {
    const self: Record<string, unknown> = {
      heldNotes: new Map([["res-chat", held]]),
    };
    self.botAnswerRead = proto.botAnswerRead.bind(self);
    return self as {
      botAnswerRead: (session: string, id: string) => void;
      heldNotes: Map<string, Array<{ note: string; tags?: unknown }>>;
    };
  };

  it("its held note says it was read, keeping the row's tags", () => {
    const h = host([
      { note: "[bot answer] Writer answered q1 …", tags: exchange("q1") },
      { note: "[bot answer] Writer answered q2 …", tags: exchange("q2") },
      { note: "a plain note" },
    ]);
    h.botAnswerRead("res-chat", "q1");
    const [first, second, plain] = h.heldNotes.get("res-chat")!;
    expect(first!.note).toContain("already read the whole answer");
    expect(first!.note).toContain("NO_REPLY");
    expect(first!.tags).toEqual(exchange("q1"));
    // Another request's note, and a plain note, are left as they were.
    expect(second!.note).toBe("[bot answer] Writer answered q2 …");
    expect(plain!.note).toBe("a plain note");
  });

  it("leaves a failure's note, and a chat with nothing held, alone", () => {
    const h = host([
      {
        note: "[bot answer] Writer could not answer",
        tags: exchange("q1", "failed"),
      },
    ]);
    h.botAnswerRead("res-chat", "q1");
    expect(h.heldNotes.get("res-chat")![0]!.note).toBe(
      "[bot answer] Writer could not answer"
    );
    h.botAnswerRead("other-chat", "q1");
    expect(h.heldNotes.has("other-chat")).toBe(false);
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
      connectivity: new ConnectivityService({ probe: async () => true }),
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
      taskRounds: new Map(),
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
      "taskTag",
      "turnClosed",
      "waitForTurn",
      "feedTurnWaiter",
      "settleTurnWaiter",
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

  it("goes into the doing bot's chat tagged as a passed-on task, for the card that stands in for its prompt", async () => {
    const { self } = taskHost(false);
    await (self.runBotAskTurn as Method)(
      {
        ...TASK,
        request: "Make the checklist",
        userWords: "have Planner make a checklist",
      },
      "TASK PROMPT",
      null
    );
    expect(self.sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "wri-main",
        message: "TASK PROMPT",
        userText: {
          operator: {
            kind: "bot-task",
            task: {
              askId: "q8",
              passerId: "res",
              passer: "Researcher",
              task: "Make the checklist",
              userWords: "have Planner make a checklist",
            },
          },
        },
      })
    );
  });

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

  it("a message that waited behind the task: it and the answer go on once the task ends", async () => {
    const { self, endUserTurn } = taskHost(false, null);
    const pending = (self.runBotAskTurn as Method)(TASK, "TASK PROMPT", null);
    await vi.waitFor(() =>
      expect(
        (self.taskTurns as Map<string, { sent: boolean }>).get("q8")?.sent
      ).toBe(true)
    );
    // Sent while the task runs: it is queued, not a step-in.
    (self.noteUserWords as Method)("wri-main", "make it 3 days, not 7");
    expect(self.stopAgentTurn).not.toHaveBeenCalled();
    (self.settleTurnWaiter as Method)({ sessionId: "wri-main", kind: "reply" });
    await expect(pending).resolves.toBe("Posted.");
    chatLog(
      ["user", "make it 3 days, not 7"],
      ["assistant", "Shortened to 3 days."]
    );
    endUserTurn();
    expect(self.tellBotAsk).toHaveBeenCalledTimes(1);
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
      userText: {
        operator: {
          kind: "bot-task",
          task: expect.objectContaining({ askId: "q8" }),
        },
      },
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

  const BOTS = [
    { id: "res", name: "Researcher" },
    { id: "wri", name: "Writer" },
    { id: "pla", name: "Planner" },
  ];
  const wordsHost = (
    bots: Array<{ id: string; name: string; delegatesFreely?: boolean }> = BOTS
  ) => {
    const self: Record<string, unknown> = {
      userWords: new Map(),
      taskRounds: new Map(),
      taskFollowUps: new Map(),
      botAskService: { ask: vi.fn(() => ({ ask: TASK, behind: 0 })) },
      botService: { list: () => bots },
      turnLedger: { channelOf: () => null },
      botAskTurns: new Map(),
      taskTurns: new Map(),
    };
    for (const name of [
      "noteUserWords",
      "latestUserWords",
      "recentUserWords",
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

  describe("as people write it (from real users' chats)", () => {
    const sent = (h: ReturnType<typeof wordsHost>) =>
      h.botAskService.ask.mock.calls.length;

    it("'ask them', 'status from them': asking about the bots in view is asking", () => {
      for (const words of [
        "yes. can you ask status from them?",
        "ask them what they are working on",
        "get an update from each of them",
        "check with the others before you decide",
      ]) {
        const h = wordsHost();
        h.noteUserWords("res-chat", words);
        h.askBot("res", "res-chat", "wri", "status please");
        expect(sent(h), words).toBe(1);
      }
    });

    it("a question may go on the bot named in the message before; a task may not", () => {
      const h = wordsHost();
      h.noteUserWords("res-chat", "can you get the numbers from Writer?");
      h.noteUserWords("res-chat", "and when does the draft land?");
      h.askBot("res", "res-chat", "wri", "when does the draft land?");
      expect(sent(h)).toBe(1);
      // Another bot than the one named before is still not asked.
      h.askBot("res", "res-chat", "pla", "when does it land?");
      expect(sent(h)).toBe(1);
      expect(
        tryTask("have Planner draft the checklist", "now make me a launch post")
          .result
      ).toEqual(handOffRefused);
    });

    it("a bot named by its own word and 'bot' ('video bot' for 'Ideas Bot For Video')", () => {
      const bots = [...BOTS, { id: "vid", name: "Ideas Bot For Video" }];
      const h = wordsHost(bots);
      h.noteUserWords("res-chat", "video bot, three ideas please");
      h.giveBotTask("res", "res-chat", "vid", "Three video ideas");
      expect(sent(h)).toBe(1);
      // A word of the name on its own names nobody.
      const plain = wordsHost(bots);
      plain.noteUserWords("res-chat", "write some ideas about video");
      expect(
        plain.giveBotTask("res", "res-chat", "vid", "Write the ideas")
      ).toEqual(handOffRefused);
    });

    it("'someone' next to a named bot leaves the others open", () => {
      const h = wordsHost();
      h.noteUserWords(
        "res-chat",
        "someone needs to gather the notes. Planner should draft the plan."
      );
      h.giveBotTask("res", "res-chat", "wri", "Gather the notes");
      expect(sent(h)).toBe(1);
    });

    it("the user's standing yes (the bot's setting) lets it ask and pass work on, only in their turn", () => {
      const bots = [
        { id: "res", name: "Researcher", delegatesFreely: true },
        ...BOTS.slice(1),
      ];
      const h = wordsHost(bots);
      h.noteUserWords("res-chat", "make me a launch checklist");
      h.giveBotTask("res", "res-chat", "pla", "Draft the checklist");
      h.askBot("res", "res-chat", "wri", "a tagline please");
      expect(sent(h)).toBe(2);
      // Not from a turn the user did not start: no chains, setting or not.
      const quiet = wordsHost(bots);
      expect(
        quiet.giveBotTask("res", "res-chat", "pla", "Draft the checklist")
      ).toEqual(refused);
      // Off by default: the same words are refused.
      expect(tryTask("make me a launch checklist").result).toEqual(
        handOffRefused
      );
    });
  });

  describe("rounds the user asked for (fix, then recheck)", () => {
    const roundsHost = () => {
      const h = wordsHost() as ReturnType<typeof wordsHost> & {
        taskRounds: Map<string, unknown>;
        withRounds: (ask: BotAskRecord, note: string, f: boolean) => string;
      };
      const self = h as unknown as Record<string, unknown>;
      let n = 0;
      const asks = new Map<string, BotAskRecord>();
      h.botAskService.ask.mockImplementation(() => {
        n += 1;
        const ask = { ...TASK, id: `t${n}`, targetId: "pla" };
        asks.set(ask.id, ask);
        return { ask, behind: 0 };
      });
      self.botAskService = {
        ask: h.botAskService.ask,
        get: (_asker: string, id: string) => ({
          ...asks.get(id),
          status: "answered",
        }),
      };
      self.taskRounds = new Map();
      self.withRounds = proto.withRounds.bind(self);
      // The doer's report arrives: a hidden note, so the user's words go.
      const report = (id: string): string => {
        h.userWords.delete("res-chat");
        return h.withRounds(asks.get(id)!, "Planner finished.", false);
      };
      const handBack = () =>
        h.giveBotTask("res", "res-chat", "pla", "Fix what is still open");
      return { h, report, handBack, sent: () => n };
    };

    it("passes work back after each report, with the user's words, up to three rounds", () => {
      const { h, report, handBack, sent } = roundsHost();
      h.noteUserWords(
        "res-chat",
        "have Planner fix the issues, then recheck until it's clean"
      );
      h.giveBotTask("res", "res-chat", "pla", "Fix the issues");
      expect(sent()).toBe(1);
      // Not before the report comes.
      h.userWords.delete("res-chat");
      expect(handBack()).toEqual(refused);
      expect(report("t1")).toContain("2 more rounds allowed");
      handBack();
      expect(sent()).toBe(2);
      expect(wordsGiven(h)).toBe(
        "have Planner fix the issues, then recheck until it's clean"
      );
      // Once per report.
      expect(handBack()).toEqual(refused);
      expect(report("t2")).toContain("1 more round allowed");
      // Only to the same doer.
      expect(
        h.giveBotTask("res", "res-chat", "wri", "Fix what is still open")
      ).toEqual(refused);
      handBack();
      expect(sent()).toBe(3);
      expect(report("t3")).toContain("last round");
      expect(handBack()).toEqual(refused);
      expect(sent()).toBe(3);
    });

    it("ends when the user speaks again, and never starts without their asking for rounds", () => {
      const asked = roundsHost();
      asked.h.noteUserWords("res-chat", "have Planner fix it and recheck");
      asked.h.giveBotTask("res", "res-chat", "pla", "Fix it");
      asked.h.noteUserWords("res-chat", "thanks, that's enough");
      expect(asked.report("t1")).toBe("Planner finished.");
      expect(asked.handBack()).toEqual(refused);

      const once = roundsHost();
      once.h.noteUserWords("res-chat", "have Planner fix the issues");
      once.h.giveBotTask("res", "res-chat", "pla", "Fix the issues");
      expect(once.report("t1")).toBe("Planner finished.");
      expect(once.handBack()).toEqual(refused);
    });
  });

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
      "好的，算了",
      "可以，但是先别做",
      "好，不用了",
      "行，別做了",
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
      "好的",
      "好的，麻烦了",
      "可以！",
      "沒問題，請幫我問",
      "嗯",
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
