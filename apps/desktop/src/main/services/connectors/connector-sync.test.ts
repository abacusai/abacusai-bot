/**
 * ConnectorSync: a session's tools follow the account's connectors, whoever
 * changed them. The failure this replaces: a phone session spawned with Gmail
 * only kept saying Drive and Calendar were not attached after they had been
 * connected from a browser, because its MCP tools were read once at spawn
 * and nothing that knew of the change refreshed it.
 */
import { describe, expect, it, vi } from "vitest";

import { ConnectorSync, type PlatformSnapshot } from "./connector-sync";

const SESSION = { workspaceId: "ws", sessionId: "phone" };

const listing = (...connected: string[]): PlatformSnapshot => ({
  available: new Set(["gmailuser", "googledriveuser", "googlecalendar"]),
  connected: new Set(connected),
  accounts: {},
});

type Answer = "done" | "never" | "failed";

/**
 * A sync over a fake platform and one fake agent. Asked to refresh, the
 * agent answers `mcp_refreshed` with the request id, as the real one does
 * once its servers are reconnected.
 */
const setup = (
  options: { live?: boolean; answer?: Answer; refreshWaitMs?: number } = {}
) => {
  const clock = { t: 0 };
  let platform: PlatformSnapshot | Error = listing("gmailuser");
  let answer: Answer = options.answer ?? "done";
  const order: string[] = [];
  const read = vi.fn(async () => {
    if (platform instanceof Error) throw platform;
    return platform;
  });
  const changed = vi.fn();
  const requestIds: string[] = [];
  const refresh = vi.fn(async (_session: unknown, requestId: string) => {
    order.push("refresh");
    requestIds.push(requestId);
    if (answer !== "never")
      setTimeout(() => sync.refreshed(requestId, answer === "done"), 5);
    return true;
  });
  const sync: ConnectorSync = new ConnectorSync({
    read,
    liveSessions: () => (options.live === false ? [] : [SESSION]),
    turnRunning: () => false,
    refresh,
    changed,
    ttlMs: 20_000,
    refreshWaitMs: options.refreshWaitMs ?? 50,
    now: () => clock.t,
  });
  /** One send: in line, reconciled unless its turn is open, then delivered. */
  const send = (label = "message") =>
    sync.inTurnOrder(SESSION, async () => {
      order.push(label);
    });
  /** A send's turn, delivered, then over. */
  const turn = async (label = "message") => {
    await send(label);
    sync.turnEnded(SESSION.sessionId);
  };
  /** The session's agent starts and reports its servers. */
  const spawn = async () => {
    await sync.platform();
    sync.serversReported(SESSION.sessionId);
  };
  return {
    sync,
    clock,
    read,
    refresh,
    requestIds,
    changed,
    order,
    send,
    turn,
    spawn,
    setPlatform: (next: PlatformSnapshot | Error) => {
      platform = next;
    },
    setAnswer: (next: Answer) => {
      answer = next;
    },
  };
};

describe("a session spawned with Gmail only", () => {
  it("sees Drive and Calendar connected from a browser on its next turn, refreshed before the message", async () => {
    const t = setup();
    await t.spawn();
    await t.turn();
    expect(t.refresh).not.toHaveBeenCalled();

    // Connected elsewhere: nothing here knew. The next turn after the TTL
    // reads the platform and refreshes the session before its message.
    t.setPlatform(listing("gmailuser", "googledriveuser", "googlecalendar"));
    t.clock.t = 21_000;
    await t.turn();

    expect(t.order).toEqual(["message", "refresh", "message"]);
    // The statuses, connect_connector and the notice read this same listing.
    expect([...(await t.sync.platform()).connected]).toEqual([
      "gmailuser",
      "googledriveuser",
      "googlecalendar",
    ]);
    // And the renderer heard of it once.
    expect(t.changed).toHaveBeenCalledTimes(1);

    // Built with the new set now: the turn after needs nothing.
    t.clock.t = 50_000;
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it("drops a connector removed elsewhere the same way", async () => {
    const t = setup();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    await t.spawn();
    t.setPlatform(listing("gmailuser"));
    t.clock.t = 21_000;
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("sends to one session", () => {
  it("keep their order, and a refresh the first starts happens before both", async () => {
    const t = setup();
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    // A arrives at an idle session and starts its reconcile; B arrives while
    // A's turn is starting and must not overtake it, nor refresh under it.
    await Promise.all([t.send("A"), t.send("B")]);
    expect(t.order).toEqual(["refresh", "A", "B"]);
  });

  it("judge a running turn at the head of the line, not at arrival: one queued behind a turn that ends reconciles", async () => {
    const t = setup();
    await t.spawn();
    await t.send("A");
    // S is in line while A's turn runs, and never reaches the agent; B waits
    // behind S. A's turn ends and the account changes before B's turn comes.
    let fail: (() => void) | null = null;
    const s = t.sync.inTurnOrder(
      SESSION,
      () =>
        new Promise<boolean>((resolve) => {
          fail = () => resolve(false);
        }),
      (reached) => reached
    );
    const b = t.send("B");
    await vi.waitFor(() => expect(fail).not.toBeNull());
    t.sync.turnEnded(SESSION.sessionId);
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    fail!();
    await Promise.all([s, b]);
    expect(t.order).toEqual(["A", "refresh", "B"]);
  });

  it("never refresh under a running turn; the next turn start does", async () => {
    const t = setup();
    await t.spawn();
    await t.send("A");
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    await t.send("steered");
    expect(t.refresh).not.toHaveBeenCalled();
    t.sync.turnEnded(SESSION.sessionId);
    await t.send("B");
    expect(t.order).toEqual(["A", "steered", "refresh", "B"]);
  });

  it("go on after a delivery that failed", async () => {
    const t = setup();
    await t.spawn();
    const failed = t.sync.inTurnOrder(SESSION, async () => {
      throw new Error("undeliverable");
    });
    const next = t.send("B");
    await expect(failed).rejects.toThrow("undeliverable");
    await next;
    expect(t.order).toEqual(["B"]);
  });
});

describe("a refresh's end", () => {
  it("is its own answer: a servers report mid-refresh does not end the wait", async () => {
    const t = setup({ answer: "never", refreshWaitMs: 5_000 });
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    const sent = t.turn();
    // The old clients closing re-report the servers before the refresh ends.
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalled());
    t.sync.serversReported(SESSION.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.order).toEqual(["refresh"]);
    // The real answer ends it.
    t.sync.refreshed(t.requestIds[0]!, true);
    await sent;
    expect(t.order).toEqual(["refresh", "message"]);
    t.clock.t = 50_000;
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

  it("an answer to another request ends nothing", async () => {
    const t = setup({ answer: "never" });
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    const sent = t.turn();
    await vi.waitFor(() => expect(t.refresh).toHaveBeenCalled());
    t.sync.refreshed("someone-else", true);
    await sent;
    // Timed out, so not recorded as built: the next turn tries again.
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("reading the platform", () => {
  it("reads once per TTL, and one read serves every caller waiting", async () => {
    const t = setup();
    await t.spawn();
    await Promise.all([t.sync.platform(), t.sync.platform(), t.turn()]);
    t.clock.t = 10_000;
    await t.turn();
    expect(t.read).toHaveBeenCalledTimes(1);
    await t.sync.platform({ fresh: true });
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it("announces a change made here once, not again when the read sees it", async () => {
    const t = setup();
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.sync.changed();
    expect(t.changed).toHaveBeenCalledTimes(1);
    // The next read is fresh despite the TTL, and stays quiet.
    await t.sync.platform();
    expect(t.read).toHaveBeenCalledTimes(2);
    expect(t.changed).toHaveBeenCalledTimes(1);
  });
});

describe("when not to refresh", () => {
  it("leaves the tools alone when the platform cannot be read", async () => {
    const t = setup();
    await t.spawn();
    t.setPlatform(new Error("unreachable"));
    t.clock.t = 21_000;
    await t.turn();
    t.setPlatform({ ...listing(), reason: "not-signed-in" });
    t.clock.t = 42_000;
    await t.turn();
    expect(t.refresh).not.toHaveBeenCalled();
    expect(t.order).toEqual(["message", "message"]);
  });

  it("does not refresh a session with no running agent: it starts on the current set", async () => {
    const t = setup({ live: false });
    await t.turn();
    expect(t.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a cold-started session on its first turn", async () => {
    // Started before anything read the platform: the start reads it.
    const t = setup();
    t.sync.serversReported(SESSION.sessionId);
    await t.turn();
    expect(t.refresh).not.toHaveBeenCalled();
    expect(t.read).toHaveBeenCalledTimes(1);
  });
});

describe("a refresh that does not finish", () => {
  it("lets the turn go on and tries again at the next one", async () => {
    const t = setup({ answer: "never" });
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    await t.turn();
    expect(t.order).toEqual(["refresh", "message"]);
    t.setAnswer("done");
    await t.turn();
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });

  it("counts a reported refresh failure the same way", async () => {
    const t = setup({ answer: "failed" });
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    await t.turn();
    t.setAnswer("done");
    await t.turn();
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });

  it("forgets a closed session, so its next agent is judged afresh", async () => {
    const t = setup();
    await t.spawn();
    t.sync.forget(SESSION.sessionId);
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });
});
