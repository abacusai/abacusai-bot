/**
 * Channel work in the bot's own chat (runChannelWork): a stop is honoured
 * whenever it comes, before the work's turn starts or while it runs, and
 * stops the turn the way the user's Stop does, never by closing the agent.
 */
import { describe, expect, it, vi } from "vitest";

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
const { TurnStoppedError } = await import("./services/session/turn-stopped");
const { answerWords } = await import("./services/bots/bot-ask");
const { ConnectivityService } =
  await import("./services/connectivity/connectivity-service");

type Method = (...args: unknown[]) => unknown;
const proto = ServiceHost.prototype as unknown as Record<string, Method>;

const workHost = (ends: string | null = null) => {
  const self: Record<string, unknown> = {
    turnWaiters: new Map(),
    // Turn waits are timed in awake time (the power clock).
    connectivity: new ConnectivityService({ probe: async () => true }),
    channelWorks: new Map(),
    channelWorkLanes: new Map(),
    turnLedger: { isOpen: () => false },
    // Its chat as kept; nothing here unless a test sets it.
    threadStore: { readCurrentFile: () => null },
    botService: {
      openChat: vi.fn(async () => ({
        botId: "wri",
        workspaceId: "ws",
        sessionId: "wri-main",
      })),
    },
    agentManagerService: { stopSession: vi.fn() },
    sessionTurnStateService: { stopSettled: vi.fn(async () => true) },
    // The card turns from waiting to running when the prompt goes.
    channelService: { workStarted: vi.fn() },
  };
  for (const name of [
    "runChannelWork",
    "runChannelWorkNow",
    "turnClosed",
    "waitForTurn",
    "feedTurnWaiter",
    "settleTurnWaiter",
    "closingText",
  ])
    self[name] = proto[name].bind(self);
  self.stopAgentTurn = vi.fn(({ sessionId }: { sessionId: string }) =>
    (self.settleTurnWaiter as Method)({ sessionId, kind: "stopped" })
  );
  self.sendAgentMessage = vi.fn(
    async ({ sessionId }: { sessionId: string }) => {
      if (ends != null) {
        (self.feedTurnWaiter as Method)(sessionId, {
          type: "event",
          event: { type: "text_delta", content: "Done.", messageId: "m1" },
        });
        (self.settleTurnWaiter as Method)({ sessionId, kind: ends });
      }
      return true;
    }
  );
  const stop = (workId: string) => {
    const work = (
      self.channelWorks as Map<
        string,
        {
          stopped: boolean;
          handle?: { workspaceId: string; sessionId: string };
        }
      >
    ).get(workId);
    if (work == null) return;
    work.stopped = true;
    if (work.handle != null) (self.stopAgentTurn as Method)(work.handle);
  };
  const run = (workId: string) =>
    (self.runChannelWork as Method)("wri", "WORK", workId, {
      askId: workId,
      passerId: "ch1",
      passer: "Launch",
      channelId: "ch1",
      task: "the task",
      userWords: "do the task",
    }) as Promise<string>;
  return { self, run, stop };
};

describe("a channel turn", () => {
  it("stopped while its hidden chat is still opening, it never sends", async () => {
    let open!: (handle: unknown) => void;
    const self: Record<string, unknown> = {
      channelTurns: new Map(),
      channelTurnsOpening: new Set(),
      channelTurnsStopped: new Set(),
      turnLedger: { isOpen: () => false },
      botService: {
        list: () => [],
        openSenderChat: vi.fn(() => new Promise((resolve) => (open = resolve))),
      },
      sendAgentMessage: vi.fn(async () => true),
    };
    const turn = (proto.runChannelTurn as Method).call(
      self,
      "wri",
      { id: "ch1", memberBotIds: ["wri"], name: "Launch" },
      "PROMPT"
    ) as Promise<string>;
    // Stop lands now: no handle yet, so it is kept for when the chat opens.
    expect((self.channelTurnsOpening as Set<string>).has("ch1|wri")).toBe(true);
    (self.channelTurnsStopped as Set<string>).add("ch1|wri");
    open({ workspaceId: "ws", sessionId: "s1" });
    await expect(turn).rejects.toThrow("it was stopped.");
    expect(self.sendAgentMessage).not.toHaveBeenCalled();
  });
});

describe("channel work", () => {
  it("runs in the bot's own chat and resolves with its report", async () => {
    const { self, run } = workHost("reply");
    await expect(run("w1")).resolves.toBe("Done.");
    // The card turned from waiting to running as the prompt went.
    expect(
      (self.channelService as { workStarted: ReturnType<typeof vi.fn> })
        .workStarted
    ).toHaveBeenCalledWith("w1");
  });

  it("reports all it wrote after its last tool call, from its chat, never the notes between steps", async () => {
    const { self, run } = workHost();
    const feed = (event: Record<string, unknown>) =>
      (self.feedTurnWaiter as Method)("wri-main", { type: "event", event });
    // Its chat as kept: notes, a tool call, more notes, a tool call, then the
    // result and a closing question as two messages.
    self.threadStore = {
      readCurrentFile: () => ({
        messages: [
          { role: "user", parts: [{ type: "text", content: "WORK" }] },
          {
            role: "assistant",
            parts: [
              { type: "text", content: "Looking it up." },
              { type: "tool-call" },
              { type: "tool-result" },
              { type: "text", content: "Currency is INR, switching." },
              { type: "tool-call" },
              { type: "tool-result" },
            ],
          },
          {
            role: "assistant",
            parts: [{ type: "text", content: "The ranked list: 1. A, 2. B" }],
          },
          {
            role: "assistant",
            parts: [{ type: "text", content: "Want me to re-check prices?" }],
          },
        ],
      }),
    };
    // The stream saw no tool events for these steps.
    self.sendAgentMessage = vi.fn(async () => {
      feed({ type: "text_delta", content: "Looking it up.", messageId: "m1" });
      feed({
        type: "text_delta",
        content: "Currency is INR, switching.",
        messageId: "m2",
      });
      feed({
        type: "text_delta",
        content: "The ranked list: 1. A, 2. B",
        messageId: "m3",
      });
      feed({
        type: "text_delta",
        content: "Want me to re-check prices?",
        messageId: "m4",
      });
      (self.settleTurnWaiter as Method)({
        sessionId: "wri-main",
        kind: "reply",
      });
      return true;
    });
    expect(answerWords(await run("w1"))).toBe(
      "The ranked list: 1. A, 2. B\n\nWant me to re-check prices?"
    );
  });

  it("a tool it ran after its last words does not cut the report", async () => {
    const { self, run } = workHost();
    const feed = (event: Record<string, unknown>) =>
      (self.feedTurnWaiter as Method)("wri-main", { type: "event", event });
    // It wrote the file, posted the email and a question, then suggested next tasks.
    self.threadStore = {
      readCurrentFile: () => ({
        messages: [
          { role: "user", parts: [{ type: "text", content: "WORK" }] },
          {
            role: "assistant",
            parts: [
              { type: "tool-call" },
              { type: "tool-result" },
              { type: "text", content: "Done. The email: Hi neighbor…" },
              { type: "text", content: "Want the Instagram version too?" },
              { type: "tool-call" },
              { type: "tool-result" },
            ],
          },
        ],
      }),
    };
    self.sendAgentMessage = vi.fn(async () => {
      feed({ type: "tool_call_start", toolName: "write", messageId: "m1" });
      feed({
        type: "text_delta",
        content: "Done. The email: Hi neighbor…",
        messageId: "m2",
      });
      feed({
        type: "text_delta",
        content: "Want the Instagram version too?",
        messageId: "m3",
      });
      feed({
        type: "tool_call_start",
        toolName: "suggest_tasks",
        messageId: "m3",
      });
      (self.settleTurnWaiter as Method)({
        sessionId: "wri-main",
        kind: "reply",
      });
      return true;
    });
    expect(answerWords(await run("w1"))).toBe(
      "Done. The email: Hi neighbor…\n\nWant the Instagram version too?"
    );
  });

  it("its chat catches up a moment after the turn: the report waits for it", async () => {
    const { self, run } = workHost();
    self.closingWaitMs = 1000;
    const feed = (event: Record<string, unknown>) =>
      (self.feedTurnWaiter as Method)("wri-main", { type: "event", event });
    const email = { type: "text", content: "Done. The email: Hi neighbor…" };
    const question = {
      type: "text",
      content: "Want the Instagram version too?",
    };
    // At first its chat has the email but not yet the closing question.
    let reads = 0;
    self.threadStore = {
      readCurrentFile: () => ({
        messages: [
          { role: "user", parts: [{ type: "text", content: "WORK" }] },
          {
            role: "assistant",
            parts: [{ type: "tool-call" }, { type: "tool-result" }, email],
          },
          ...(++reads > 2 ? [{ role: "assistant", parts: [question] }] : []),
        ],
      }),
    };
    self.sendAgentMessage = vi.fn(async () => {
      feed({ type: "text_delta", content: email.content, messageId: "m1" });
      feed({ type: "text_delta", content: question.content, messageId: "m2" });
      (self.settleTurnWaiter as Method)({
        sessionId: "wri-main",
        kind: "reply",
      });
      return true;
    });
    expect(answerWords(await run("w1"))).toBe(
      "Done. The email: Hi neighbor…\n\nWant the Instagram version too?"
    );
  });

  it("its chat not written up to the end yet: the report is what streamed", async () => {
    const { self, run } = workHost("reply");
    self.threadStore = {
      readCurrentFile: () => ({
        messages: [
          { role: "user", parts: [{ type: "text", content: "WORK" }] },
          {
            role: "assistant",
            parts: [{ type: "text", content: "Older words." }],
          },
        ],
      }),
    };
    await expect(run("w1")).resolves.toBe("Done.");
  });

  it("waits out a turn opened in its own chat while it waited, so that answer is never its report", async () => {
    const { self, run } = workHost("reply");
    // The chat closed, but the user wrote there before the work went in.
    const open = [true, false];
    self.turnLedger = { isOpen: () => open.shift() ?? false };
    self.turnClosed = vi.fn(async () => true);
    await expect(run("w1")).resolves.toBe("Done.");
    expect(self.turnClosed).toHaveBeenCalledTimes(2);
    expect(self.sendAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("stopped by the user in its own chat: it ends as stopped, not failed", async () => {
    const { run } = workHost("stopped");
    const result = run("w1");
    await expect(result).rejects.toBeInstanceOf(TurnStoppedError);
    await expect(result).rejects.toThrow("stopped partway");
  });

  it("a stop before its turn starts: it never starts", async () => {
    const { self, run, stop } = workHost("reply");
    const pending = run("w1");
    stop("w1");
    await expect(pending).rejects.toThrow(/stopped before it began/);
    expect(self.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("a stop while it runs stops the turn as the user's Stop does, never closing the agent", async () => {
    const { self, run, stop } = workHost();
    const pending = run("w1");
    await vi.waitFor(() => expect(self.sendAgentMessage).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop("w1");
    await expect(pending).rejects.toThrow(/stopped partway/);
    expect(self.stopAgentTurn).toHaveBeenCalled();
    expect(
      (self.agentManagerService as { stopSession: ReturnType<typeof vi.fn> })
        .stopSession
    ).not.toHaveBeenCalled();
  });

  it("two works of one bot: stopping the waiting one leaves the running one", async () => {
    const { self, run, stop } = workHost();
    const first = run("w1");
    const second = run("w2");
    await vi.waitFor(() =>
      expect(self.sendAgentMessage).toHaveBeenCalledTimes(1)
    );
    stop("w2");
    expect(self.stopAgentTurn).not.toHaveBeenCalled();
    (self.settleTurnWaiter as Method)({ sessionId: "wri-main", kind: "reply" });
    await expect(first).resolves.toBe("");
    await expect(second).rejects.toThrow(/stopped before it began/);
    expect(self.sendAgentMessage).toHaveBeenCalledTimes(1);
  });
});
