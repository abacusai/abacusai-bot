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

type Method = (...args: unknown[]) => unknown;
const proto = ServiceHost.prototype as unknown as Record<string, Method>;

const workHost = (ends: string | null = null) => {
  const self: Record<string, unknown> = {
    turnWaiters: new Map(),
    channelWorks: new Map(),
    channelWorkLanes: new Map(),
    turnLedger: { isOpen: () => false },
    botService: {
      openChat: vi.fn(async () => ({
        botId: "wri",
        workspaceId: "ws",
        sessionId: "wri-main",
      })),
    },
    agentManagerService: { stopSession: vi.fn() },
    sessionTurnStateService: { stopSettled: vi.fn(async () => true) },
  };
  for (const name of [
    "runChannelWork",
    "runChannelWorkNow",
    "turnClosed",
    "waitForTurn",
    "feedTurnWaiter",
    "settleTurnWaiter",
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
    (self.runChannelWork as Method)(
      "wri",
      "ch1",
      "WORK",
      workId
    ) as Promise<string>;
  return { self, run, stop };
};

describe("channel work", () => {
  it("runs in the bot's own chat and resolves with its report", async () => {
    const { run } = workHost("reply");
    await expect(run("w1")).resolves.toBe("Done.");
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
