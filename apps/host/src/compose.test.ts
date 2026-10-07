import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
const fixture = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "host-compose-"));
  process.env.ABACUSAI_BOT_HOME = home;
  delete process.env.ABACUS_API_KEY;
  mkdirSync(join(home, "host-userdata"));
  const config = '{"apiKeys":{"ABACUS_API_KEY":"sentinel"}}\n';
  writeFileSync(join(home, "config.json"), config);
  writeFileSync(
    join(home, "host-userdata/config.json"),
    JSON.stringify({
      localCode: {
        workspaces: [
          { id: "legacy", name: "Legacy", path: home, description: home },
        ],
        agentSessions: [],
        activeWorkspaceId: "legacy",
      },
    })
  );
  return { home, config };
});
import { connectInProcess } from "#main/rpc/testing";
import { SessionTurnStateService } from "#main/services/session/session-turn-state-service";
import { TurnAbandoner } from "#main/services/session/turn-abandoner";

import { composeNodeHost } from "./compose";
import { PhoneInbox } from "./phone-inbox";
import { PhoneLane } from "./phone-lane";
import Store from "./store";
import { HostUnsupportedError } from "./unsupported";

// A real service composition and a memory transport isolate only the machine and network.
it("initializes and starts under the shim; migrates workspace stores without touching bot config", async () => {
  // The sentinel is a filesystem assertion, not a credential for network work.
  const configPath = join(fixture.home, "config.json");
  const original = readFileSync(configPath, "utf8");
  const { mainEventBus } = await import("#main/rpc/event-bus");
  const listenersBefore = mainEventBus.listenerCount();
  const host = await composeNodeHost();
  const transport = connectInProcess(host.deps, {
    platform: "web-host",
    webContentsId: null,
    windowKind: "web",
  });
  try {
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const migrated = JSON.parse(
      readFileSync(join(fixture.home, "local-code.json"), "utf8")
    );
    expect(migrated.localCode.workspaces[0].id).toBe("legacy");
    expect(migrated.migrated_from_default_v1).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(fixture.home, "host-userdata/config.json"), "utf8")
      ).localCode
    ).toEqual({});
    expect(await transport.client.system.info()).toMatchObject({
      platform: process.platform,
    });
    expect(await transport.client.account.state()).toHaveProperty("onboarded");
    await expect(transport.client.update.status()).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    const created = host.serviceHost.createAgentSession("legacy");
    expect(host.serviceHost.hostUploadFolder("legacy", created.id)).toBe(
      fixture.home
    );
    expect(host.serviceHost.hostUploadFolder("other", created.id)).toBeNull();
    expect(host.serviceHost.hostUploadFolder("legacy", "unknown")).toBeNull();
    const snapshot = await transport.client.db.sessions.snapshot();
    expect(snapshot.rows.some((row) => row.id === created.id)).toBe(true);
    await transport.client.system.activity();
    expect(host.lease.lastActivityAt).toBeGreaterThan(0);
    for (const service of ["render_document", "render_deck", "render_design"])
      await expect(
        host.serviceHost.runAgentHostService(service, {})
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    for (const service of [
      "document_templates",
      "design_catalog",
      "deck_templates",
    ])
      await expect(
        host.serviceHost.runAgentHostService(service, {})
      ).resolves.toBeDefined();
    await expect(
      host.serviceHost.runAgentHostService("deck_slots", {
        template: "nonexistent",
      })
    ).rejects.not.toBeInstanceOf(HostUnsupportedError);
    await expect(
      host.serviceHost.mcpOAuthSignIn({ mode: "code", name: "x" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      host.serviceHost.importMcpServers({ mode: "code", source: "file" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      host.serviceHost.skillsService.openFile({ path: "/tmp/x" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(host.serviceHost.clearBrowserData()).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(() => host.serviceHost.listBrowserProfiles()).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED" })
    );
    vi.stubGlobal(
      "fetch",
      async () => new Response("offline", { status: 403 })
    );
    await expect(
      transport.client.auth.abacus.signOut({ keepOtherApiKeys: true })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(
      JSON.parse(readFileSync(configPath, "utf8")).apiKeys.ABACUS_API_KEY
    ).toBe("sentinel");
  } finally {
    transport.closeClient();
    transport.closeServer();
    await host.serviceHost.getRuntimeMcpPathForSpawn("code", "dispose-test");
    const mcp = (host.serviceHost as any).mcpAgentToolsServer;
    const port = mcp.port;
    expect(mcp.isRunning()).toBe(true);
    await host.dispose();
    expect(mcp.isRunning()).toBe(false);
    expect(mainEventBus.listenerCount()).toBe(listenersBefore);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("MCP listener survived disposal"));
      });
      socket.once("error", () => resolve());
    });
    const handles = (process as any)._getActiveHandles();
    expect(
      handles.filter((h: any) => h.constructor.name === "Server" && h.listening)
    ).toEqual([]);
    vi.unstubAllGlobals();
  }
}, 20_000);
it("conf preserves dotted keys, defaults, deletion and a separate userData default store", () => {
  const store = new Store<Record<string, unknown>>({
    name: "store-test",
    defaults: { enabled: true },
    clearInvalidConfig: true,
  });
  expect(store.get("enabled")).toBe(true);
  store.set("nested.key", "value");
  expect(store.get("nested.key")).toBe("value");
  store.delete("nested.key");
  expect(store.get("nested.key", "fallback")).toBe("fallback");
  expect(store.path).toBe(join(fixture.home, "host-userdata/store-test.json"));
});
describe("connectors connected elsewhere", () => {
  /** A composed host over a fake platform, with one running session. */
  const harness = async (lane?: string) => {
    const host = await composeNodeHost();
    const sh = host.serviceHost as any;
    // What the session's agent reports to main, through main's own wiring.
    const agent = sh.agentManagerService.options;
    const order: string[] = [];
    let active = ["gmailuser"];
    const names: Record<string, string> = {
      gmailuser: "Gmail",
      googledriveuser: "Google Drive",
      googlecalendar: "Google Calendar",
    };
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const method = new URL(String(input)).pathname.split("/").at(-1);
      const result =
        method === "_listAbacusbotConnectors"
          ? Object.fromEntries(
              Object.entries(names).map(([key, name]) => [
                key.toUpperCase(),
                { name },
              ])
            )
          : method === "_listActiveUserLevelConnectors"
            ? active.map((service) => ({
                service: service.toUpperCase(),
                applicationConnectorId: `id-${service}`,
                name: `${names[service]} - ada@example.com`,
              }))
            : null;
      return result == null
        ? new Response("{}", { status: 404 })
        : Response.json({ success: true, result });
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    const session =
      lane == null
        ? sh.createAgentSession("legacy")
        : {
            id: (await sh.openLaneSession(lane, {}, "auto")).sessionId,
          };
    const workspaceId = sh.agentSessionManagerService.get(
      session.id
    ).workspaceId;
    vi.spyOn(sh.agentManagerService, "getRuntimeDiagnostics").mockReturnValue([
      { workspaceId, sessionId: session.id, live: true, mcpServers: new Map() },
    ]);
    // The agent reconnects: its servers are re-reported while the old
    // clients close (which must not end the wait), then it answers.
    vi.spyOn(sh.mcpAdminService, "refreshSessionMcp").mockImplementation(
      async (_session: unknown, requestId: unknown) => {
        order.push("refresh");
        setTimeout(() => {
          agent.emitMcpRuntimeServers(workspaceId, session.id, []);
          setTimeout(
            () => agent.emitMcpRefreshed(session.id, requestId, true),
            20
          );
        }, 0);
        return true;
      }
    );
    vi.spyOn(sh.agentCommunicationService, "sendMessage").mockImplementation(
      (request: any) => {
        // The message itself; any environment notice rides below it.
        order.push(request.message.split("\n")[0]);
        return true;
      }
    );
    // The session's agent starts, before anything read the platform; the
    // start reads it.
    agent.emitMcpRuntimeServers(workspaceId, session.id, []);
    await sh.connectorSync.platform();
    return {
      sh,
      order,
      session,
      workspaceId,
      connect: (...services: string[]) => {
        active = services;
        vi.setSystemTime(Date.now() + 21_000);
      },
      turn: (message: string) =>
        sh.sendAgentMessage({ workspaceId, sessionId: session.id, message }),
      endTurn: () =>
        sh.sessionTurnStateService.markStopped(workspaceId, session.id),
      landed: (...connectorIds: string[]) =>
        sh.connectorsConnected({
          sessionId: session.id,
          connectorIds,
          notGranted: [],
          accounts: {},
        }),
      dispose: async () => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await host.dispose();
      },
    };
  };

  it("reach a running phone session's tools before its next turn, in order, and every reader agrees", async () => {
    const t = await harness();
    try {
      // Cold start: its first turn needs no reconnect.
      await t.turn("hi");
      expect(t.order).toEqual(["hi"]);
      t.endTurn();

      // Drive and Calendar connected from a browser; two messages back to
      // back: the second must neither overtake the first nor skip the refresh.
      t.connect("gmailuser", "googledriveuser", "googlecalendar");
      await Promise.all([
        t.turn("fetch my drive docs"),
        t.turn("and calendar"),
      ]);
      expect(t.order).toEqual([
        "hi",
        "refresh",
        "fetch my drive docs",
        "and calendar",
      ]);
      // And nothing tells the model Drive is missing.
      const statuses = await t.sh.listConnectorStatuses();
      expect(statuses["abacus-googledriveuser"].state).toBe("connected");
      expect(statuses["abacus-googlecalendar"].state).toBe("connected");
      const asked = await t.sh.mcpAgentToolsServer.connectConnector({
        service: "googledriveuser",
      });
      expect(asked.content[0].text).toContain(
        "Google Drive is already connected"
      );
    } finally {
      await t.dispose();
    }
  }, 20_000);

  it("tell a desktop session that asked mid-turn in a fresh turn once that turn ends, with the tools refreshed first", async () => {
    const t = await harness();
    try {
      await t.turn("connect my drive and list my docs");
      // Connected while the asking turn still runs: the note waits.
      t.connect("gmailuser", "googledriveuser");
      t.landed("abacus-googledriveuser");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(t.order).toEqual(["connect my drive and list my docs"]);

      t.endTurn();
      await vi.waitFor(() => expect(t.order).toHaveLength(3));
      expect(t.order[1]).toBe("refresh");
      expect(t.order[2]).toMatch(
        /^\[connected\] Google Drive is connected now/
      );
      // A turn of its own, hidden from the transcript.
      const note = (t.sh.agentCommunicationService.sendMessage as any).mock
        .calls[1][0];
      expect(note.userText).toMatchObject({
        operator: { kind: "environment-notice" },
      });
    } finally {
      await t.dispose();
    }
  }, 20_000);

  it("tell an idle desktop session at once", async () => {
    const t = await harness();
    try {
      t.connect("gmailuser", "googledriveuser");
      t.landed("abacus-googledriveuser");
      await vi.waitFor(() => expect(t.order).toHaveLength(2));
      expect(t.order[0]).toBe("refresh");
      expect(t.order[1]).toMatch(
        /^\[connected\] Google Drive is connected now/
      );
    } finally {
      await t.dispose();
    }
  }, 20_000);

  it("hand the phone lane's note to the lane, the one path its answer reaches the phone by", async () => {
    const t = await harness("phone");
    const notes: string[] = [];
    const stop = t.sh.onLaneNote("phone", (note: string) => notes.push(note));
    try {
      t.landed("abacus-googledriveuser");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^\[connected\] Google Drive/);
      expect(t.order).toEqual([]);
    } finally {
      stop();
      await t.dispose();
    }
  }, 20_000);
});
/** A screenshot the media store holds. */
const SHOT = "media-00112233445566778899aabb";
const SHOT_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7]);

describe("the phone lane", () => {
  const lane = (
    options: {
      refuse?: (messageId: string) => boolean;
      replyFails?: (text: string) => boolean;
      /** The server refuses every image reply. */
      imageFails?: boolean;
      /** Holds each reply until the test lets it go. */
      holdReplies?: boolean;
      stop?: (workspaceId: string, sessionId: string) => Promise<void>;
      timings?: Record<string, number>;
    } = {}
  ) => {
    const held: Array<() => void> = [];
    const calls: Array<Record<string, unknown>> = [];
    let listener: (sessionId: string, payload: never) => void = () => {};
    const send = vi.fn(
      async (_w: string, _s: string, _text: string, messageId: string) =>
        !(options.refuse?.(messageId) ?? false)
    );
    const activity = vi.fn();
    let settleStop: () => void = () => {};
    const stop = vi.fn(
      options.stop ??
        (() => new Promise<void>((resolve) => (settleStop = resolve)))
    );
    const phone = new PhoneLane(
      {
        call: (async (body: Record<string, unknown>) => {
          calls.push(body);
          if (body.action === "reply" && options.holdReplies === true)
            await new Promise<void>((resolve) => held.push(resolve));
          if (
            body.action === "reply" &&
            options.replyFails?.(String(body.text)) === true
          )
            return { ok: false, error: "closed" };
          if (body.image_b64 != null && options.imageFails === true)
            return { ok: false, error: "image refused" };
          return { ok: true };
        }) as never,
        hasKey: () => false,
        openSession: async () => ({ workspaceId: "w", sessionId: "s" }),
        stop,
        send,
        onAgentEvent: (next) => {
          listener = next as never;
          return () => {};
        },
        activity,
        resolveMedia: (ref: string, sessionId: string) =>
          ref === SHOT && sessionId === "s"
            ? {
                ok: true as const,
                data: SHOT_BYTES,
                mimeType: "image/jpeg" as const,
              }
            : { ok: false as const, reason: "unknown" },
        log: () => {},
      },
      {
        batchMs: 0,
        keyWaitMs: 60_000,
        bubblePauseMinMs: 0,
        bubblePauseMaxMs: 0,
        deliveryRetryMs: [0, 0],
        ...options.timings,
      }
    );
    phone.start();
    const event = (inner: Record<string, unknown>) =>
      listener("s", { type: "event", event: inner } as never);
    const reply = (messageIds: string[], text: string, failed = false) =>
      event({ type: "turn_reply", messageIds, text, failed });
    const replies = () => calls.filter((body) => body.action === "reply");
    const acks = () =>
      calls
        .filter((body) => body.action === "ack")
        .map((body) => body.message_ids);
    const release = () => held.splice(0).forEach((resolve) => resolve());
    return {
      phone,
      calls,
      send,
      stop,
      settleStop: () => settleStop(),
      activity,
      event,
      reply,
      replies,
      acks,
      release,
    };
  };

  it("sends a progress line at once and acks only once the final answer is out", async () => {
    const { phone, send, activity, event, reply, replies, acks } = lane();
    phone.arrive({ id: "m1", text: "find flights to Goa" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenLastCalledWith(
      "w",
      "s",
      "find flights to Goa",
      "m1"
    );
    const before = activity.mock.calls.length;

    event({
      type: "tool_execution_complete",
      tool: { name: "send_progress", input: { text: "On it: Goa flights" } },
      result: { rejected: false },
    });

    await vi.waitFor(() =>
      expect(replies()).toEqual([
        { action: "reply", message_id: "m1", text: "On it: Goa flights" },
      ])
    );
    expect(activity.mock.calls.length).toBeGreaterThan(before);
    expect(acks()).toEqual([]);
    expect(phone.busy).toBe(true);
    reply(["m1"], "Cheapest is 4,200.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    expect(replies().map((body) => body.text)).toEqual([
      "On it: Goa flights",
      "Cheapest is 4,200.",
    ]);
    expect(phone.busy).toBe(false);
    phone.stop();
  });

  it("sends an image at once with its caption, and keeps the turn open", async () => {
    const { phone, send, event, reply, replies, acks, calls } = lane();
    phone.arrive({ id: "m1", text: "share a screenshot?" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    event({
      type: "tool_execution_complete",
      tool: {
        name: "send_media",
        input: { media: SHOT, caption: "The payment page" },
      },
      result: { rejected: false },
    });

    await vi.waitFor(() =>
      expect(replies()).toEqual([
        {
          action: "reply",
          message_id: "m1",
          image_b64: SHOT_BYTES.toString("base64"),
          text: "The payment page",
        },
      ])
    );
    // Still working: "typing…" comes back, and nothing is acknowledged yet.
    await vi.waitFor(() =>
      expect(calls.at(-1)).toEqual({ action: "typing", message_id: "m1" })
    );
    expect(acks()).toEqual([]);
    reply(["m1"], "Ready for you to pay.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    phone.stop();
  });

  it("sends with_answer media with the final answer, its first bubble as the caption", async () => {
    const { phone, send, event, reply, replies, acks } = lane();
    phone.arrive({ id: "m1", text: "take me to the payment page" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event({
      type: "tool_execution_complete",
      tool: { name: "send_media", input: { media: SHOT, when: "with_answer" } },
      result: { rejected: false },
    });
    // Held: nothing goes out before the answer.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies()).toEqual([]);

    reply(["m1"], "It is ready for you to pay.\n---\nTotal: 4,200.");

    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    expect(replies()).toEqual([
      {
        action: "reply",
        message_id: "m1",
        image_b64: SHOT_BYTES.toString("base64"),
        text: "It is ready for you to pay.",
      },
      { action: "reply", message_id: "m1", text: "Total: 4,200." },
    ]);
    phone.stop();
  });

  it("still says the words when an image cannot go, and still answers", async () => {
    const { phone, send, event, reply, replies, acks } = lane({
      imageFails: true,
    });
    phone.arrive({ id: "m1", text: "show me" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event({
      type: "tool_execution_complete",
      tool: {
        name: "send_media",
        input: { media: "media-ffffffffffffffffffffffff", caption: "Gone" },
      },
      result: { rejected: false },
    });
    event({
      type: "tool_execution_complete",
      tool: { name: "send_media", input: { media: SHOT, when: "with_answer" } },
      result: { rejected: false },
    });
    reply(["m1"], "Here it is.");

    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    // An unknown id never reaches the server; a refused image leaves its words.
    expect(replies()).toEqual([
      { action: "reply", message_id: "m1", text: "Gone" },
      {
        action: "reply",
        message_id: "m1",
        image_b64: SHOT_BYTES.toString("base64"),
        text: "Here it is.",
      },
      { action: "reply", message_id: "m1", text: "Here it is." },
    ]);
    phone.stop();
  });

  it("never sends what the tool refused, nor a call that ended in an error", async () => {
    const { phone, send, event, reply, replies, acks } = lane();
    phone.arrive({ id: "m1", text: "show me" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const done = (
      name: string,
      input: Record<string, unknown>,
      rejected = false
    ) =>
      event({
        type: "tool_execution_complete",
        tool: { name, input },
        result: { rejected },
      });

    // Refused by the tool's own check, whatever the result said.
    done("send_media", { media: SHOT, caption: "x".repeat(501) });
    done("send_media", { media: SHOT, when: "later" });
    done("send_media", { media: "/home/user/secret.png" });
    done("send_progress", { text: "y".repeat(501) });
    // Accepted input, but the call failed.
    done("send_media", { media: SHOT, caption: "Failed call" }, true);
    done("send_progress", { text: "Failed call" }, true);
    // The model's corrected retry goes out, once.
    done("send_media", { media: SHOT, caption: "The page" });

    reply(["m1"], "Done.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    expect(replies()).toEqual([
      {
        action: "reply",
        message_id: "m1",
        image_b64: SHOT_BYTES.toString("base64"),
        text: "The page",
      },
      { action: "reply", message_id: "m1", text: "Done." },
    ]);
    phone.stop();
  });

  it("drops media held for a turn that failed", async () => {
    const { phone, send, event, reply, replies, acks } = lane();
    phone.arrive({ id: "m1", text: "book it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event({
      type: "tool_execution_complete",
      tool: { name: "send_media", input: { media: SHOT, when: "with_answer" } },
      result: { rejected: false },
    });
    reply(["m1"], "", true);

    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    expect(replies().some((body) => body.image_b64 != null)).toBe(false);
    phone.stop();
  });

  it("steers a message in by its id and answers against it once the session names it", async () => {
    const { phone, send, event, reply, replies, acks, calls } = lane();
    phone.arrive({ id: "m1", text: "find flights to Goa" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    phone.arrive({ id: "m2", text: "only nonstop" });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith("w", "s", "only nonstop", "m2");
    expect(calls).toContainEqual({ action: "typing", message_id: "m2" });
    event({
      type: "user_message_steered",
      content: "only nonstop",
      messageId: "m2",
    });
    reply(["m1", "m2"], "Nonstop: 5,100.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1", "m2"]]));
    expect(replies()).toEqual([
      { action: "reply", message_id: "m2", text: "Nonstop: 5,100." },
    ]);
    expect(phone.busy).toBe(false);
    phone.stop();
  });

  it("requeues a refused steer exactly once and hands it over after the turn", async () => {
    let refusals = 0;
    const { phone, send, reply, replies, acks } = lane({
      refuse: (id) => id === "m2" && refusals++ === 0,
    });
    phone.arrive({ id: "m1", text: "find flights to Goa" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    phone.arrive({ id: "m2", text: "only nonstop" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    // The session never names a refused message: only m1 is this turn's.
    reply(["m1", "m2"], "Found 3 flights.");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenLastCalledWith("w", "s", "only nonstop", "m2");
    expect(acks()).toEqual([["m1"]]);
    reply(["m2"], "Two of them are nonstop.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"], ["m2"]]));
    expect(replies().map((body) => [body.message_id, body.text])).toEqual([
      ["m1", "Found 3 flights."],
      ["m2", "Two of them are nonstop."],
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    phone.stop();
  });

  it("treats the same text twice as two messages, each answered by its own id", async () => {
    const { phone, send, reply, replies, acks } = lane();
    phone.arrive({ id: "m1", text: "book a table" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    phone.arrive({ id: "m2", text: "ok" });
    phone.arrive({ id: "m3", text: "ok" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls.map((call) => call[3])).toEqual(["m1", "m2", "m3"]);

    reply(["m1", "m2"], "Booked for 8.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1", "m2"]]));
    expect(phone.busy).toBe(true);
    reply(["m3"], "Anything else?");
    await vi.waitFor(() => expect(acks()).toEqual([["m1", "m2"], ["m3"]]));
    expect(replies().map((body) => body.message_id)).toEqual(["m2", "m3"]);
    phone.stop();
  });

  it("never acks on progress alone: a final answer that cannot be sent is left for redelivery", async () => {
    const { phone, send, event, reply, replies, acks } = lane({
      replyFails: (text) => text === "Here it is.",
    });
    phone.arrive({ id: "m1", text: "plan my trip" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event({
      type: "tool_execution_complete",
      tool: { name: "send_progress", input: { text: "Working on it" } },
      result: { rejected: false },
    });
    reply(["m1"], "Here it is.");

    await vi.waitFor(() => expect(phone.busy).toBe(false));
    // Tried, then tried once more.
    expect(replies().map((body) => body.text)).toEqual([
      "Working on it",
      "Here it is.",
      "Here it is.",
    ]);
    expect(acks()).toEqual([]);

    // The server hands it back: a new message, not a lost ack.
    phone.arrive({ id: "m1", text: "plan my trip" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    phone.stop();
  });

  it("acks a failed turn once the apology is out", async () => {
    const { phone, send, reply, replies, acks } = lane();
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "", true);
    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    expect(replies()).toHaveLength(1);
    phone.stop();
  });

  it("restarts the idle limit on tool progress and gives up at the hard cap", async () => {
    vi.useFakeTimers();
    try {
      const { phone, send, stop, settleStop, event, replies, acks } = lane({
        timings: { idleMs: 1_000, hardCapMs: 5_000 },
      });
      phone.arrive({ id: "m1", text: "research this" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);

      for (let step = 0; step < 4; step += 1) {
        await vi.advanceTimersByTimeAsync(900);
        event({ type: "tool_execution_start", tool: { name: "browser_task" } });
      }
      // 3.6 s in, never idle for 1 s: still working.
      expect(phone.busy).toBe(true);
      expect(replies()).toEqual([]);

      for (let step = 0; step < 2; step += 1) {
        await vi.advanceTimersByTimeAsync(900);
        event({ type: "text_delta", content: "…", messageId: "a" });
      }
      await vi.advanceTimersByTimeAsync(0);
      // Past the cap however busy: the session is stopped and the user gets the apology.
      expect(stop).toHaveBeenCalledWith("w", "s");
      expect(replies()).toHaveLength(1);
      // Held until the session is idle.
      expect(phone.busy).toBe(true);
      settleStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(phone.busy).toBe(false);
      expect(replies()).toHaveLength(1);
      expect(acks()).toEqual([["m1"]]);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the idle limit with no sign of work", async () => {
    vi.useFakeTimers();
    try {
      const { phone, send, settleStop, replies } = lane({
        timings: { idleMs: 1_000, hardCapMs: 60_000 },
      });
      phone.arrive({ id: "m1", text: "research this" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      settleStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(phone.busy).toBe(false);
      expect(replies()).toHaveLength(1);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up atomically: a message arriving during the apology waits for the stopped session, then goes alone", async () => {
    vi.useFakeTimers();
    try {
      const { phone, send, stop, settleStop, reply, replies, acks, release } =
        lane({
          holdReplies: true,
          timings: { idleMs: 1_000, hardCapMs: 60_000 },
        });
      phone.arrive({ id: "m1", text: "research this" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      // The apology is on its way; the session is being stopped.
      expect(replies()).toHaveLength(1);
      expect(stop).toHaveBeenCalledTimes(1);

      phone.arrive({ id: "m2", text: "are you there?" });
      await vi.advanceTimersByTimeAsync(0);
      // Not steered into the abandoned work.
      expect(send).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      settleStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(acks()).toEqual([["m1"]]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith("w", "s", "are you there?", "m2");

      // A new clock: the new message is answered normally.
      reply(["m2"], "Yes, here.");
      await vi.advanceTimersByTimeAsync(0);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(acks()).toEqual([["m1"], ["m2"]]);
      expect(phone.busy).toBe(false);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is free again when the session never stops: its owner closes it at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const turnState = new SessionTurnStateService(() => {});
      const closeSession = vi.fn(async () => {});
      const abandoner = new TurnAbandoner({
        clearQueue: () => true,
        // Taken, but the agent never confirms idle.
        stopTurn: () => true,
        markStopped: (workspaceId, sessionId) =>
          turnState.markStopped(workspaceId, sessionId),
        stopSettled: (sessionId, deadlineMs) =>
          turnState.stopSettled(sessionId, deadlineMs),
        closeSession,
        log: () => {},
        settleMs: 5_000,
      });
      const { phone, send, replies } = lane({
        stop: async (workspaceId, sessionId) => {
          await abandoner.abandon(workspaceId, sessionId);
        },
        timings: { idleMs: 1_000, hardCapMs: 60_000 },
      });
      phone.arrive({ id: "m1", text: "research this" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(replies()).toHaveLength(1);
      expect(phone.busy).toBe(true);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(closeSession).toHaveBeenCalledWith("w", "s");
      expect(phone.busy).toBe(false);
      phone.arrive({ id: "m2", text: "hello?" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a refused handoff that carries a note already handed once", async () => {
    let refusals = 0;
    const { phone, send, reply, acks } = lane({
      replyFails: (text) => text === "Gmail is connected.",
      refuse: (id) => id === "m2" && refusals++ === 0,
    });
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "Hello!");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    phone.note("[connected] gmail");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    reply([send.mock.calls[1]![3]], "Gmail is connected.");
    await vi.waitFor(() => expect(phone.busy).toBe(false));

    phone.arrive({ id: "m2", text: "thanks" });
    // Refused: handed again after the retry wait, note and message together.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    expect(send.mock.calls[3]![2]).toBe("[connected] gmail\n\nthanks");
    reply(["m2"], "Anytime!");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"], ["m2"]]));
    phone.stop();
  });

  it("keeps a host note whose answer could not be sent, and sends it with the user's next message", async () => {
    const { phone, send, reply, acks } = lane({
      replyFails: (text) => text === "Gmail is connected.",
    });
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "Hello!");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));

    phone.note("[connected] gmail");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const noteId = send.mock.calls[1]![3];
    reply([noteId], "Gmail is connected.");
    await vi.waitFor(() => expect(phone.busy).toBe(false));
    // Not handed again on its own: it waits for the user.
    expect(send).toHaveBeenCalledTimes(2);

    phone.arrive({ id: "m2", text: "thanks" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![2]).toBe("[connected] gmail\n\nthanks");
    phone.stop();
  });
});

describe("the phone inbox", () => {
  it("allows only its own transitions", () => {
    const inbox = new PhoneInbox();
    expect(inbox.add({ id: "m1", text: "hi" })).toBe(true);
    expect(inbox.add({ id: "m1", text: "hi" })).toBe(false);
    const m1 = inbox.get("m1")!;

    expect(() => inbox.requeue([m1])).toThrow(/queued, not handed/);
    expect(() => inbox.release([m1])).toThrow(/queued, not closing/);
    inbox.hand([m1], "m1");
    expect(() => inbox.hand([m1], "m1")).toThrow(/handed, not queued/);
    expect(() => inbox.answer([m1])).toThrow(/handed, not queued/);
    expect(inbox.handedUnder(["m1"])).toEqual([m1]);

    expect(inbox.close([m1])).toEqual([m1]);
    // Claimed once: a second close finds nothing.
    expect(inbox.close([m1])).toEqual([]);
    expect(inbox.abandon()).toEqual([]);
    inbox.answer([m1]);
    expect(m1.state).toBe("answered");
    expect(() => inbox.release([m1])).toThrow(/answered, not closing/);
  });

  it("forgets a released server message but queues a released note again", () => {
    const inbox = new PhoneInbox();
    inbox.add({ id: "m1", text: "hi" });
    inbox.add({ id: "note-1", kind: "note", text: "connected" });
    const both = inbox.queued();
    inbox.hand(both, "m1");
    inbox.release(inbox.abandon());
    expect(inbox.get("m1")).toBeUndefined();
    expect(inbox.get("note-1")).toMatchObject({ state: "queued", handoffs: 1 });
  });
});
afterAll(() => {
  rmSync(fixture.home, { recursive: true, force: true });
});
