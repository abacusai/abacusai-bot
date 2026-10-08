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
import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import { visibleUserText } from "@abacus-ai/contract/transcript/user-text";

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
            id: (await sh.openLaneSession(lane, {}, "auto", WHATSAPP_CHANNEL))
              .sessionId,
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

  /** A vault page the session sent, which the platform now reports completed. */
  const vaultPageCompleted = (t: { sh: any; session: { id: string } }) => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) =>
      new URL(String(input)).pathname.endsWith(
        "_getAbacusbotVaultRequestStatus"
      )
        ? Response.json({
            success: true,
            result: { status: "completed", itemId: "login-7" },
          })
        : real(input, init)
    );
    t.sh.vault.sessions.for(t.session.id).requests.set("req-1", {
      requestId: "req-1",
      kind: "login",
      site: "example.com",
      itemId: null,
      forPayment: false,
      expiresAt: Date.now() + 60_000,
    });
  };

  it("tell an idle desktop session that a vault page was completed, in a fresh hidden turn", async () => {
    const t = await harness();
    try {
      vaultPageCompleted(t);
      await t.sh.vault.waiter.tick();
      await vi.waitFor(() =>
        expect(t.order.some((line) => line.startsWith("[vault]"))).toBe(true)
      );
      const sent = (
        t.sh.agentCommunicationService.sendMessage as any
      ).mock.calls.at(-1)[0];
      expect(sent.message).toContain("login-7");
      expect(sent.userText).toMatchObject({
        operator: { kind: "environment-notice" },
      });
    } finally {
      await t.dispose();
    }
  }, 20_000);

  it("hand a vault outcome for the phone session to the phone lane", async () => {
    const t = await harness("phone");
    const notes: string[] = [];
    const stop = t.sh.onLaneNote("phone", (note: string) => notes.push(note));
    try {
      vaultPageCompleted(t);
      await t.sh.vault.waiter.tick();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^\[vault\] The user saved their login/);
      expect(t.order).toEqual([]);
    } finally {
      stop();
      await t.dispose();
    }
  }, 20_000);

  it('put what a "done" finds ahead of the user\'s words in that message, hidden from the transcript', async () => {
    const t = await harness();
    try {
      vaultPageCompleted(t);
      await t.turn("done");
      const sent = (t.sh.agentCommunicationService.sendMessage as any).mock
        .calls[0][0];
      expect(sent.message).toMatch(/^<system_reminder>\n\[vault\]/);
      expect(sent.message).toContain("</system_reminder>\n\ndone");
      expect(visibleUserText(sent.message, sent.userText)).toBe("done");
      // Told once: nothing follows as a turn of its own.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(t.order.filter((line) => line.startsWith("[vault]"))).toHaveLength(
        0
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
/** Another capture of the very same page: a new id, the same bytes. */
const SHOT_AGAIN = "media-00112233445566778899aaff";
const PDF = "media-aabbccddeeff00112233445566";
const PDF_BYTES = Buffer.from("%PDF-1.7 love");
const DOCX = "media-66554433221100ffeeddccbbaa";
const DOCX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9]);

/** A present_deliverable result that hands these media ids to the chat. */
const presented = (ids: string[]) => ({
  type: "tool_execution_complete",
  tool: { name: "present_deliverable", input: { items: [] } },
  result: {
    rejected: false,
    content: [
      "Sending 2 items to this chat with your answer:",
      "",
      ...ids.map((id) => `[media] ${id}`),
      "[artifact] /work/love.pdf",
    ].join("\n"),
  },
});

describe("the phone lane", () => {
  const lane = (
    options: {
      refuse?: (messageId: string) => boolean;
      replyFails?: (text: string) => boolean;
      /** The server refuses every image reply. */
      imageFails?: boolean;
      /** The server does not take documents yet. */
      documentFails?: boolean;
      /** The server does not answer a document reply in time. */
      documentTimesOut?: boolean;
      /** The server refuses this many image replies, then takes them. */
      imageFailsTimes?: number;
      /** Holds each reply until the test lets it go. */
      holdReplies?: boolean;
      stop?: (workspaceId: string, sessionId: string) => Promise<void>;
      timings?: Record<string, number>;
      /** The server fails this many acks, then takes them. */
      ackFailsTimes?: number;
      /** Holds the session's answer to these sends until `settleSend`. */
      holdSend?: (messageId: string) => boolean;
      /** How the server answers a reply carrying a notice. */
      notice?: "unknown" | "timeout";
      /** The server says another host holds these messages now. */
      superseded?: (messageId: string) => boolean;
      /** These sends throw on their way (outcome unknown). */
      throwSend?: (messageId: string) => boolean;
    } = {}
  ) => {
    const held: Array<() => void> = [];
    const calls: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    let listener: (sessionId: string, payload: never) => void = () => {};
    let settleSend: (taken: boolean) => void = () => {};
    const send = vi.fn(
      async (_w: string, _s: string, _text: string, messageId: string) => {
        if (options.throwSend?.(messageId) === true)
          throw new Error("socket closed");
        if (options.holdSend?.(messageId) === true)
          return new Promise<boolean>((resolve) => (settleSend = resolve));
        return !(options.refuse?.(messageId) ?? false);
      }
    );
    const activity = vi.fn();
    const pinMedia = vi.fn();
    // Ticks vitest's own call counter, so server calls order against mocks.
    const order = vi.fn(() => order.mock.invocationCallOrder.at(-1)!);
    const callOrder: number[] = [];
    let settleStop: () => void = () => {};
    const stop = vi.fn(
      options.stop ??
        (() => new Promise<void>((resolve) => (settleStop = resolve)))
    );
    const phone = new PhoneLane(
      {
        call: (async (body: Record<string, unknown>) => {
          calls.push(body);
          callOrder.push(order());
          if (body.action === "ack" && (options.ackFailsTimes ?? 0) > 0) {
            options.ackFailsTimes! -= 1;
            throw new Error("ack failed");
          }
          if (body.action === "reply" && options.holdReplies === true)
            await new Promise<void>((resolve) => held.push(resolve));
          if (body.action === "reply" && body.notice != null) {
            if (options.notice === "unknown")
              throw new Error("text is required");
            if (options.notice === "timeout")
              throw Object.assign(new Error("timed out"), {
                name: "TimeoutError",
              });
          }
          if (
            body.action === "reply" &&
            options.superseded?.(String(body.message_id)) === true
          )
            return { ok: false, error: "superseded" };
          if (
            body.action === "reply" &&
            options.replyFails?.(String(body.text)) === true
          )
            return { ok: false, error: "closed" };
          if (body.image_b64 != null && options.imageFails === true)
            return { ok: false, error: "image refused" };
          if (body.document_b64 != null && options.documentFails === true)
            throw new Error("unknown field document_b64");
          if (body.document_b64 != null && options.documentTimesOut === true)
            throw Object.assign(new Error("timed out"), {
              name: "TimeoutError",
            });
          if (body.image_b64 != null && (options.imageFailsTimes ?? 0) > 0) {
            options.imageFailsTimes! -= 1;
            return { ok: false, error: "try later" };
          }
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
          sessionId !== "s"
            ? { ok: false as const, reason: "unknown" }
            : ref === SHOT || ref === SHOT_AGAIN
              ? {
                  ok: true as const,
                  kind: "image" as const,
                  data: SHOT_BYTES,
                  mimeType: "image/jpeg" as const,
                }
              : ref === PDF || ref === DOCX
                ? {
                    ok: true as const,
                    kind: "document" as const,
                    data: ref === PDF ? PDF_BYTES : DOCX_BYTES,
                    filename: ref === PDF ? "love.pdf" : "notes.docx",
                  }
                : { ok: false as const, reason: "unknown" },
        pinMedia,
        log: (line) => logs.push(line),
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
    // Every reply names this host's poller; the tests read what it says.
    const replies = () =>
      calls
        .filter((body) => body.action === "reply")
        .map(({ poller, ...rest }) => {
          expect(poller).toEqual(expect.any(String));
          return rest;
        });
    const acks = () =>
      calls
        .filter((body) => body.action === "ack")
        .map((body) => body.message_ids);
    const release = () => held.splice(0).forEach((resolve) => resolve());
    /** Waits for these acks, and for every acked turn's answer to have gone out (or been dropped). */
    const handled = (expected: unknown[]) =>
      vi.waitFor(() => {
        expect(acks()).toEqual(expected);
        expect(
          logs.filter((line) => /^\[phone\] (reply ids=|gave up)/.test(line))
        ).toHaveLength(expected.length);
      });
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
      pinMedia,
      callOrder,
      handled,
      logs,
      settleSend: (taken: boolean) => settleSend(taken),
    };
  };

  it("sends a progress line at once and acks only once the final answer is out", async () => {
    const { phone, send, activity, event, reply, replies, acks, handled } =
      lane();
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
    await handled([["m1"]]);
    expect(replies().map((body) => body.text)).toEqual([
      "On it: Goa flights",
      "Cheapest is 4,200.",
    ]);
    expect(phone.busy).toBe(false);
    phone.stop();
  });

  it("sends an image at once with its caption, and keeps the turn open", async () => {
    const { phone, send, event, reply, replies, acks, calls, handled } = lane();
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
    await handled([["m1"]]);
    phone.stop();
  });

  it("sends with_answer media with the final answer, its first bubble as the caption", async () => {
    const { phone, send, event, reply, replies, handled } = lane();
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

    await handled([["m1"]]);
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
    const { phone, send, event, reply, replies, handled } = lane({
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

    await handled([["m1"]]);
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
    const { phone, send, event, reply, replies, handled } = lane();
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
    await handled([["m1"]]);
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
    const { phone, send, event, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "book it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event({
      type: "tool_execution_complete",
      tool: { name: "send_media", input: { media: SHOT, when: "with_answer" } },
      result: { rejected: false },
    });
    reply(["m1"], "", true);

    await handled([["m1"]]);
    expect(replies().some((body) => body.image_b64 != null)).toBe(false);
    phone.stop();
  });

  it("sends what present_deliverable handed over with the answer: a pdf, a docx and an image", async () => {
    const { phone, send, event, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "share a 1 page pdf on love" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event(presented([PDF, DOCX, SHOT]));
    reply(["m1"], "Here's your one-pager on love.");

    await handled([["m1"]]);
    // The answer rides on the first file as its caption.
    expect(replies()).toEqual([
      {
        action: "reply",
        message_id: "m1",
        document_b64: PDF_BYTES.toString("base64"),
        filename: "love.pdf",
        text: "Here's your one-pager on love.",
      },
      {
        action: "reply",
        message_id: "m1",
        document_b64: DOCX_BYTES.toString("base64"),
        filename: "notes.docx",
      },
      {
        action: "reply",
        message_id: "m1",
        image_b64: SHOT_BYTES.toString("base64"),
      },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    phone.stop();
  });

  it("sends nothing from a present_deliverable call that ended in an error", async () => {
    const { phone, send, event, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "send it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const failed = presented([PDF]);
    event({ ...failed, result: { ...failed.result, rejected: true } });
    reply(["m1"], "Done.");

    await handled([["m1"]]);
    expect(replies()).toEqual([
      { action: "reply", message_id: "m1", text: "Done." },
    ]);
    phone.stop();
  });

  it("when the server cannot take a document, still says the words and has the session tell the user", async () => {
    const { phone, send, event, reply, replies, handled } = lane({
      documentFails: true,
    });
    phone.arrive({ id: "m1", text: "share a 1 page pdf on love" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event(presented([PDF]));
    reply(["m1"], "Here's your one-pager on love.");

    await handled([["m1"]]);
    expect(replies()).toEqual([
      {
        action: "reply",
        message_id: "m1",
        document_b64: PDF_BYTES.toString("base64"),
        filename: "love.pdf",
        text: "Here's your one-pager on love.",
      },
      {
        action: "reply",
        message_id: "m1",
        text: "Here's your one-pager on love.",
      },
    ]);
    // Never dropped in silence: a turn of its own says so, in the user's language.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const note = String(send.mock.calls[1]![2]);
    expect(note).toContain("love.pdf could not be attached");
    expect(note).toContain("in their language");
    phone.stop();
  });

  it("sends a media id once: the loop resending a browser run's screenshot is a no-op", async () => {
    const { phone, send, event, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "open it and send me a screenshot" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sendMedia = (id: string) =>
      event({
        type: "tool_execution_complete",
        tool: { name: "send_media", input: { media: SHOT, caption: "Here" } },
        result: { rejected: false, id },
      });
    sendMedia("web-1");
    sendMedia("toolu_2");
    event(presented([SHOT]));
    reply(["m1"], "Done.");

    await handled([["m1"]]);
    expect(replies().filter((body) => body.image_b64 != null)).toHaveLength(1);
    phone.stop();
  });

  it("sends the same picture once a turn, whatever its id", async () => {
    const { phone, send, event, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "screenshot please" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    for (const media of [SHOT, SHOT_AGAIN])
      event({
        type: "tool_execution_complete",
        tool: { name: "send_media", input: { media, when: "with_answer" } },
        result: { rejected: false },
      });
    reply(["m1"], "Here it is.");

    await handled([["m1"]]);
    expect(replies()).toEqual([
      {
        action: "reply",
        message_id: "m1",
        image_b64: SHOT_BYTES.toString("base64"),
        text: "Here it is.",
      },
    ]);
    // Nothing went wrong, so the session is told nothing.
    expect(send).toHaveBeenCalledTimes(1);
    phone.stop();
  });

  it("counts a media id as sent only once the server took it: a refused one goes on a retry", async () => {
    const { phone, send, event, reply, replies, handled } = lane({
      imageFailsTimes: 1,
    });
    phone.arrive({ id: "m1", text: "screenshot please" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sendMedia = () =>
      event({
        type: "tool_execution_complete",
        tool: { name: "send_media", input: { media: SHOT } },
        result: { rejected: false },
      });
    sendMedia();
    sendMedia();
    sendMedia();
    reply(["m1"], "Done.");

    await handled([["m1"]]);
    // Refused, then taken on the retry, then skipped: it went once.
    expect(replies().filter((body) => body.image_b64 != null)).toHaveLength(2);
    phone.stop();
  });

  it("raises one note per file and one per user message, however often it fails", async () => {
    const { phone, send, event, reply, acks, handled } = lane({
      documentFails: true,
    });
    phone.arrive({ id: "m1", text: "send both" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event(presented([PDF, DOCX]));
    reply(["m1"], "Here they are.");
    await handled([["m1"]]);
    // Two files failed under one message: one note.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    reply(["m1"], "Sorry, they did not come through.");
    phone.arrive({ id: "m2", text: "try the pdf again" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    event(presented([PDF]));
    reply(["m2"], "Here it is.");
    await vi.waitFor(() => expect(acks()).toContainEqual(["m2"]));
    // The same file again: no second note.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      send.mock.calls.filter((call) =>
        String(call[2]).startsWith("[not attached]")
      )
    ).toHaveLength(1);
    phone.stop();
  });

  it("a document WhatsApp did not confirm in time: logged unknown, the session told it is unconfirmed, nothing repeated", async () => {
    const { phone, send, event, reply, replies, handled } = lane({
      documentTimesOut: true,
    });
    phone.arrive({ id: "m1", text: "share a 1 page pdf on love" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event(presented([PDF]));
    reply(["m1"], "Here's your one-pager on love.");

    await handled([["m1"]]);
    expect(replies()).toHaveLength(1);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const note = String(send.mock.calls[1]![2]);
    expect(note).toContain("[delivery unconfirmed]");
    expect(note).toContain("Do not tell the user it failed");
    expect(note).toContain("NO_REPLY");
    phone.stop();
  });

  it("reads only the app's own present_deliverable, by name or under its server", async () => {
    const { phone, send, event, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "send it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const named = (name: string, ids: string[]) => {
      const done = presented(ids);
      event({ ...done, tool: { ...done.tool, name } });
    };
    named("some-server_present_deliverable", [DOCX]);
    named("agent-tools_present_deliverable", [PDF]);
    reply(["m1"], "Here.");

    await handled([["m1"]]);
    expect(replies().map((body) => body.filename)).toEqual(["love.pdf"]);
    phone.stop();
  });

  it("keeps what an answer holds from eviction until the answer went", async () => {
    const { phone, send, event, reply, pinMedia, calls, callOrder, handled } =
      lane();
    phone.arrive({ id: "m1", text: "send it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event(presented([PDF]));
    expect(pinMedia).toHaveBeenLastCalledWith(PDF, "s", true);
    reply(["m1"], "Here.");
    await handled([["m1"]]);
    expect(pinMedia).toHaveBeenLastCalledWith(PDF, "s", false);
    // Let go only after the file went out, never before.
    const unpinned = pinMedia.mock.invocationCallOrder.at(-1)!;
    const documentSent = calls.findIndex((body) => body.document_b64 != null);
    expect(documentSent).toBeGreaterThanOrEqual(0);
    expect(callOrder[documentSent]!).toBeLessThan(unpinned);
    phone.stop();
  });

  it("when an image handed over cannot go, the session tells the user too", async () => {
    const { phone, send, event, reply, handled } = lane({
      imageFails: true,
    });
    phone.arrive({ id: "m1", text: "send me the chart" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    event(presented([SHOT]));
    reply(["m1"], "Here's the chart.");

    await handled([["m1"]]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(String(send.mock.calls[1]![2])).toContain(
      "An image you handed over could not be attached"
    );
    phone.stop();
  });

  it("steers a message in by its id and answers against it once the session names it", async () => {
    const { phone, send, event, reply, replies, calls, handled } = lane();
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
    await handled([["m1", "m2"]]);
    expect(replies()).toEqual([
      { action: "reply", message_id: "m2", text: "Nonstop: 5,100." },
    ]);
    expect(phone.busy).toBe(false);
    phone.stop();
  });

  it("requeues a refused steer exactly once and hands it over after the turn", async () => {
    let refusals = 0;
    const { phone, send, reply, replies, acks, handled } = lane({
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
    await handled([["m1"], ["m2"]]);
    expect(replies().map((body) => [body.message_id, body.text])).toEqual([
      ["m1", "Found 3 flights."],
      ["m2", "Two of them are nonstop."],
    ]);
    expect(send).toHaveBeenCalledTimes(3);
    phone.stop();
  });

  it("treats the same text twice as two messages, each answered by its own id", async () => {
    const { phone, send, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "book a table" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    phone.arrive({ id: "m2", text: "ok" });
    phone.arrive({ id: "m3", text: "ok" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls.map((call) => call[3])).toEqual(["m1", "m2", "m3"]);

    reply(["m1", "m2"], "Booked for 8.");
    await handled([["m1", "m2"]]);
    expect(phone.busy).toBe(true);
    reply(["m3"], "Anything else?");
    await handled([["m1", "m2"], ["m3"]]);
    expect(replies().map((body) => body.message_id)).toEqual(["m2", "m3"]);
    phone.stop();
  });

  it("acks a turn whose answer could not be sent: retried as a send, dropped, never run again", async () => {
    const { phone, send, event, reply, replies, acks, handled } = lane({
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

    await handled([["m1"]]);
    // Tried, then tried once more, then dropped.
    expect(replies().map((body) => body.text)).toEqual([
      "Working on it",
      "Here it is.",
      "Here it is.",
    ]);
    expect(phone.busy).toBe(false);

    // Handed back anyway (the ack was lost): acknowledged again, not run again.
    phone.arrive({ id: "m1", text: "plan my trip" });
    await vi.waitFor(() => expect(acks()).toEqual([["m1"], ["m1"]]));
    expect(send).toHaveBeenCalledTimes(1);
    phone.stop();
  });

  it("retries an ack that failed until the server takes it, so the message is not run again", async () => {
    vi.useFakeTimers();
    try {
      const { phone, send, reply, calls } = lane({ ackFailsTimes: 1 });
      phone.arrive({ id: "m1", text: "book it" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      reply(["m1"], "Booked.");
      await vi.advanceTimersByTimeAsync(0);
      const ackCalls = () => calls.filter((body) => body.action === "ack");
      expect(ackCalls()).toHaveLength(1);
      // Owed, and sent again after the backoff.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ackCalls().map((body) => body.message_ids)).toEqual([
        ["m1"],
        ["m1"],
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ackCalls()).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(1);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the host up while an ack is owed, without holding back new turns", async () => {
    vi.useFakeTimers();
    try {
      const { phone, send, reply } = lane({ ackFailsTimes: 1 });
      phone.arrive({ id: "m1", text: "book it" });
      await vi.advanceTimersByTimeAsync(0);
      reply(["m1"], "Booked.");
      await vi.advanceTimersByTimeAsync(0);
      expect(phone.busy).toBe(false);
      expect(phone.holdsHost).toBe(true);
      // A new message still goes at once.
      phone.arrive({ id: "m2", text: "thanks" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2);
      reply(["m2"], "Anytime.");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(phone.holdsHost).toBe(false);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never hands a message again when its send threw: the session may have it", async () => {
    let throws = 1;
    const { phone, send, reply, acks, handled } = lane({
      throwSend: () => throws-- > 0,
    });
    phone.arrive({ id: "m1", text: "book it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Not retried as a refusal would be.
    expect(send).toHaveBeenCalledTimes(1);
    // The session had it after all and answers: acked as handled.
    reply(["m1"], "Booked.");
    await handled([["m1"]]);
    expect(acks()).toEqual([["m1"]]);
    phone.stop();
  });

  it("does not ask the user to send again what will run anyway", async () => {
    vi.useFakeTimers();
    try {
      const { phone, settleStop, settleSend, replies } = lane({
        holdSend: (id) => id === "m2",
        timings: { idleMs: 1_000, hardCapMs: 60_000 },
      });
      phone.arrive({ id: "m1", text: "research this" });
      await vi.advanceTimersByTimeAsync(0);
      phone.arrive({ id: "m2", text: "only nonstop" });
      await vi.advanceTimersByTimeAsync(1_000);
      settleStop();
      settleSend(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(replies()[0]!.text).toMatch(/on your latest message/);
      expect(replies()[0]!.text).not.toMatch(/send that again/);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a resend when the send still on its way at the stop turns out taken", async () => {
    vi.useFakeTimers();
    try {
      const { phone, settleStop, settleSend, replies } = lane({
        holdSend: (id) => id === "m2",
        timings: { idleMs: 1_000, hardCapMs: 60_000 },
      });
      phone.arrive({ id: "m1", text: "research this" });
      await vi.advanceTimersByTimeAsync(0);
      phone.arrive({ id: "m2", text: "only nonstop" });
      await vi.advanceTimersByTimeAsync(1_000);
      // No apology yet: the wording waits for the send's outcome.
      expect(replies()).toEqual([]);
      // The session had taken m2: it ran in the stopped work, nothing runs next.
      settleSend(true);
      settleStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(replies()[0]!.text).toMatch(/send that again/);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up acking only what the session took: a steer still on its way goes again", async () => {
    vi.useFakeTimers();
    try {
      const { phone, send, settleStop, settleSend, acks } = lane({
        holdSend: (id) => id === "m2",
        timings: { idleMs: 1_000, hardCapMs: 60_000 },
      });
      phone.arrive({ id: "m1", text: "research this" });
      await vi.advanceTimersByTimeAsync(0);
      phone.arrive({ id: "m2", text: "only nonstop" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(2);
      // Idle limit: the work is given up while m2's send is still out.
      await vi.advanceTimersByTimeAsync(1_000);
      settleStop();
      // The stopped session refuses the send that was on its way.
      settleSend(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(acks()).toEqual([["m1"]]);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]![3]).toBe("m2");
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a request once when its reply is refused, and hands the host's notes over once", async () => {
    const { phone, send, reply, acks, handled } = lane({
      replyFails: (text) => text === "Booked: PNR X1.",
    });
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "Hello!");
    await handled([["m1"]]);

    // A vault note and the user's request go to the session together.
    phone.note("[vault] The user saved their login for skyfare.com.");
    phone.arrive({ id: "m2", text: "book it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![2]).toBe(
      "[vault] The user saved their login for skyfare.com.\n\nbook it"
    );
    reply([send.mock.calls[1]![3]], "Booked: PNR X1.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"], ["m2"]]));
    await vi.waitFor(() => expect(phone.busy).toBe(false));

    // The server hands m2 back (its ack lost): no second booking.
    phone.arrive({ id: "m2", text: "book it" });
    await vi.waitFor(() => expect(acks()).toHaveLength(3));
    expect(send).toHaveBeenCalledTimes(2);

    // The user's next message goes alone: the note is not carried again.
    phone.arrive({ id: "m3", text: "thanks" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![2]).toBe("thanks");
    phone.stop();
  });

  it("leaves a message unacknowledged when the host dies mid-turn, so the server hands it back", async () => {
    const first = lane();
    first.phone.arrive({ id: "m1", text: "book it" });
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(1));
    // The host goes away before the turn ends.
    first.phone.stop();
    first.reply(["m1"], "Booked.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.acks()).toEqual([]);

    // The next host is handed it again, and runs it.
    const next = lane();
    next.phone.arrive({ id: "m1", text: "book it" });
    await vi.waitFor(() => expect(next.send).toHaveBeenCalledTimes(1));
    next.reply(["m1"], "Booked.");
    await next.handled([["m1"]]);
    next.phone.stop();
  });

  it("acks a failed turn once the apology is out", async () => {
    const { phone, send, reply, replies, handled } = lane();
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "", true);
    await handled([["m1"]]);
    expect(replies()).toHaveLength(1);
    phone.stop();
  });

  it("asks the server for the apology in the chat's language, and says it in English when the server does not know it", async () => {
    const known = lane();
    known.phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(known.send).toHaveBeenCalledTimes(1));
    known.reply(["m1"], "", true);
    await known.handled([["m1"]]);
    expect(known.replies()).toEqual([
      { action: "reply", message_id: "m1", notice: "turn_failed" },
    ]);
    known.phone.stop();

    // An older server reads a notice as a reply with no text, and refuses it.
    const older = lane({ notice: "unknown" });
    older.phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(older.send).toHaveBeenCalledTimes(1));
    older.reply(["m1"], "", true);
    await older.handled([["m1"]]);
    expect(older.replies()).toEqual([
      { action: "reply", message_id: "m1", notice: "turn_failed" },
      {
        action: "reply",
        message_id: "m1",
        text: "Sorry, something went wrong on my side. Could you send that again?",
      },
    ]);
    older.phone.stop();
  });

  it("never apologizes twice: a notice that may have gone, or one the server refused, gets no English one after it", async () => {
    for (const options of [
      { notice: "timeout" as const },
      { replyFails: (text: string) => text === "undefined" },
    ]) {
      const { phone, send, reply, replies, handled } = lane(options);
      phone.arrive({ id: "m1", text: "hi" });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      reply(["m1"], "", true);
      await handled([["m1"]]);
      expect(replies()).toEqual([
        { action: "reply", message_id: "m1", notice: "turn_failed" },
      ]);
      phone.stop();
    }
  });

  it("answers, then acks with its poller; a reply the server refuses as superseded goes no further", async () => {
    const { phone, send, reply, replies, acks, calls } = lane({
      superseded: (id) => id === "m2",
    });
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "Hello!\n---\nHow can I help?");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"]]));
    const order = calls
      .filter((body) => body.action === "reply" || body.action === "ack")
      .map((body) => body.action);
    expect(order).toEqual(["reply", "reply", "ack"]);
    const ack = calls.find((body) => body.action === "ack")!;
    expect(ack.poller).toEqual(expect.any(String));
    expect(ack.poller).toBe(
      calls.find((body) => body.action === "reply")!.poller
    );

    // A newer host took m2 over: the first bubble is refused, the rest never go.
    phone.arrive({ id: "m2", text: "book it" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    reply(["m2"], "Booked.\n---\nPNR X1.");
    await vi.waitFor(() => expect(acks()).toEqual([["m1"], ["m2"]]));
    expect(replies().filter((body) => body.message_id === "m2")).toEqual([
      { action: "reply", message_id: "m2", text: "Booked." },
      { action: "reply", message_id: "m2", text: "Booked." },
    ]);
    phone.stop();
  });

  it("gives a browser run its own idle limit, and the usual one once it is done", async () => {
    vi.useFakeTimers();
    try {
      const { phone, send, settleStop, event, replies } = lane({
        timings: { idleMs: 1_000, longToolIdleMs: 3_000, hardCapMs: 60_000 },
      });
      phone.arrive({ id: "m1", text: "book it" });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      event({
        type: "tool_execution_start",
        tool: { id: "t1", name: "browser_task" },
      });
      // A quiet sub-agent call: past the usual limit, inside the run's own.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(replies()).toEqual([]);
      event({
        type: "tool_execution_complete",
        tool: { id: "t1", name: "browser_task", input: {} },
        result: { content: "Done." },
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(replies()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      settleStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(replies()).toHaveLength(1);
      phone.stop();
    } finally {
      vi.useRealTimers();
    }
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

  it("retries a refused handoff, a host note in it included, and hands the note over once", async () => {
    let refusals = 0;
    const { phone, send, reply, handled, acks } = lane({
      refuse: (id) => id.startsWith("note-") && refusals++ === 0,
    });
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "Hello!");
    await handled([["m1"]]);

    phone.note("[connected] gmail");
    // Refused, then handed again after the retry wait.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![2]).toBe("[connected] gmail");
    reply([send.mock.calls[2]![3]], "Gmail is connected.");
    await vi.waitFor(() => expect(phone.busy).toBe(false));

    phone.arrive({ id: "m2", text: "thanks" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    expect(send.mock.calls[3]![2]).toBe("thanks");
    reply(["m2"], "Anytime!");
    // The note's turn answers nobody's message, so it acks nothing.
    await vi.waitFor(() => expect(acks()).toEqual([["m1"], ["m2"]]));
    phone.stop();
  });

  it("hands a host note over once, even when its answer could not be sent", async () => {
    const { phone, send, reply, handled } = lane({
      replyFails: (text) => text === "Gmail is connected.",
    });
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "Hello!");
    await handled([["m1"]]);

    phone.note("[connected] gmail");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    reply([send.mock.calls[1]![3]], "Gmail is connected.");
    await vi.waitFor(() => expect(phone.busy).toBe(false));
    expect(send).toHaveBeenCalledTimes(2);

    phone.arrive({ id: "m2", text: "thanks" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![2]).toBe("thanks");
    phone.stop();
  });

  it("hands a host note as one tagged line, so it is never taken for the user's words", async () => {
    const { phone, send, reply, handled } = lane({});
    phone.arrive({ id: "m1", text: "hi" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    reply(["m1"], "Hello!");
    await handled([["m1"]]);

    phone.note("The page was completed.\n\nyes");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![2]).toBe("[note] The page was completed. yes");
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
    inbox.hand([m1], "m1");
    expect(() => inbox.hand([m1], "m1")).toThrow(/handed, not queued/);
    expect(() => inbox.handle([m1])).toThrow(/handed, not queued/);
    expect(inbox.handedUnder(["m1"])).toEqual([m1]);

    expect(inbox.close([m1])).toEqual([m1]);
    // Claimed once: a second close finds nothing.
    expect(inbox.close([m1])).toEqual([]);
    expect(inbox.abandon()).toEqual([]);
    inbox.handle([m1]);
    expect(m1.state).toBe("handled");
    expect(() => inbox.requeue([m1])).toThrow(/handled, not handed/);
  });

  it("keeps a handled message and the note that rode with it handled, never queued again", () => {
    const inbox = new PhoneInbox();
    inbox.add({ id: "m1", text: "hi" });
    inbox.add({ id: "note-1", kind: "note", text: "connected" });
    inbox.hand(inbox.queued(), "m1");
    inbox.handle(inbox.abandon());
    expect(inbox.get("m1")).toMatchObject({ state: "handled" });
    expect(inbox.get("note-1")).toMatchObject({ state: "handled" });
    expect(inbox.queued()).toEqual([]);
  });
});
afterAll(() => {
  rmSync(fixture.home, { recursive: true, force: true });
});
