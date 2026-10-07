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

/** A sync over a fake platform and one fake agent that reports when asked. */
const setup = (options: { live?: boolean; agentAnswers?: boolean } = {}) => {
  const clock = { t: 0 };
  let platform: PlatformSnapshot | Error = listing("gmailuser");
  const order: string[] = [];
  const read = vi.fn(async () => {
    if (platform instanceof Error) throw platform;
    return platform;
  });
  const changed = vi.fn();
  const refresh = vi.fn(async (session: { sessionId: string }) => {
    order.push("refresh");
    // The agent reconnects and reports its servers, as the real one does.
    if (options.agentAnswers !== false)
      queueMicrotask(() => sync.serversReported(session.sessionId));
    return true;
  });
  const sync: ConnectorSync = new ConnectorSync({
    read,
    liveSessions: () => (options.live === false ? [] : [SESSION]),
    refresh,
    changed,
    ttlMs: 20_000,
    refreshWaitMs: 50,
    now: () => clock.t,
  });
  /** One turn: reconcile, then the message goes in. */
  const turn = async (midTurn = false) => {
    await sync.beforeTurn(SESSION, midTurn);
    order.push("message");
  };
  /** The session's agent starts and reports what it was built with. */
  const spawn = async () => {
    await sync.platform();
    sync.serversReported(SESSION.sessionId);
  };
  return {
    sync,
    clock,
    read,
    refresh,
    changed,
    order,
    turn,
    spawn,
    setPlatform: (next: PlatformSnapshot | Error) => {
      platform = next;
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

    expect(t.refresh).toHaveBeenCalledTimes(1);
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

describe("reading the platform", () => {
  it("reads once per TTL, and one read serves every caller waiting", async () => {
    const t = setup();
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
  it("never refreshes under a running turn; the next turn start does", async () => {
    const t = setup();
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    await t.turn(true);
    expect(t.refresh).not.toHaveBeenCalled();
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });

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

  it("refreshes once a running session whose start it never saw", async () => {
    const t = setup();
    await t.turn();
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("a refresh that does not finish", () => {
  it("lets the turn go on and tries again at the next one", async () => {
    const t = setup({ agentAnswers: false });
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    await t.turn();
    expect(t.order).toEqual(["refresh", "message"]);
    await t.turn();
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });

  it("counts a reported refresh failure the same way", async () => {
    const t = setup({ agentAnswers: false });
    await t.spawn();
    t.setPlatform(listing("gmailuser", "googledriveuser"));
    t.clock.t = 21_000;
    t.refresh.mockImplementationOnce(async () => {
      queueMicrotask(() => t.sync.refreshFailed(SESSION.sessionId));
      return true;
    });
    await t.turn();
    t.refresh.mockImplementationOnce(async () => {
      queueMicrotask(() => t.sync.serversReported(SESSION.sessionId));
      return true;
    });
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
