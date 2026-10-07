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

import { composeNodeHost } from "./compose";
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
describe("the phone lane", () => {
  const lane = (steerTaken = true) => {
    const calls: Array<Record<string, unknown>> = [];
    let listener: (sessionId: string, payload: never) => void = () => {};
    const send = vi.fn(async () => steerTaken || send.mock.calls.length !== 2);
    const activity = vi.fn();
    const phone = new PhoneLane(
      {
        call: (async (body: Record<string, unknown>) => {
          calls.push(body);
          return { ok: true };
        }) as never,
        hasKey: () => false,
        openSession: async () => ({ workspaceId: "w", sessionId: "s" }),
        send,
        onAgentEvent: (next) => {
          listener = next as never;
          return () => {};
        },
        activity,
        log: () => {},
      },
      {
        batchMs: 0,
        keyWaitMs: 60_000,
        bubblePauseMinMs: 0,
        bubblePauseMaxMs: 0,
      }
    );
    phone.start();
    const event = (inner: Record<string, unknown>) =>
      listener("s", { type: "event", event: inner } as never);
    const status = (status: string) =>
      event({ type: "status_changed", status });
    const replies = () => calls.filter((body) => body.action === "reply");
    return { phone, calls, send, activity, event, status, replies };
  };

  it("sends a progress line at once, quoting the message, and counts it as activity", async () => {
    const { phone, send, activity, event, status, replies, calls } = lane();
    phone.arrive({ id: "m1", text: "find flights to Goa" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    status("submitted");
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
    expect(phone.busy).toBe(true);
    event({
      type: "text_delta",
      content: "Cheapest is 4,200.",
      messageId: "a",
    });
    status("idle");
    await vi.waitFor(() =>
      expect(calls.at(-1)).toEqual({ action: "ack", message_ids: ["m1"] })
    );
    expect(replies().map((body) => body.text)).toEqual([
      "On it: Goa flights",
      "Cheapest is 4,200.",
    ]);
    phone.stop();
  });

  it("steers a message into the running turn and answers against it", async () => {
    const { phone, send, event, status, replies, calls } = lane();
    phone.arrive({ id: "m1", text: "find flights to Goa" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    status("submitted");

    phone.arrive({ id: "m2", text: "only nonstop" });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith("w", "s", "only nonstop");
    expect(calls).toContainEqual({ action: "typing", message_id: "m2" });
    event({ type: "user_message_steered", content: "only nonstop" });
    event({ type: "text_delta", content: "Nonstop: 5,100.", messageId: "a" });
    status("idle");
    await vi.waitFor(() =>
      expect(calls.at(-1)).toEqual({
        action: "ack",
        message_ids: ["m1", "m2"],
      })
    );
    expect(replies()).toEqual([
      { action: "reply", message_id: "m2", text: "Nonstop: 5,100." },
    ]);
    expect(phone.busy).toBe(false);
    phone.stop();
  });

  it("sends an answer already written before a queued message runs as its own turn", async () => {
    const { phone, send, event, status, replies } = lane();
    phone.arrive({ id: "m1", text: "what is 2+2" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    status("submitted");
    event({ type: "text_delta", content: "4", messageId: "a" });
    phone.arrive({ id: "m2", text: "thanks" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    event({ type: "user_message_dequeued", content: "thanks" });

    await vi.waitFor(() => expect(replies().map((b) => b.text)).toEqual(["4"]));
    event({ type: "text_delta", content: "Anytime!", messageId: "b" });
    status("idle");
    await vi.waitFor(() =>
      expect(replies().map((b) => b.text)).toEqual(["4", "Anytime!"])
    );
    phone.stop();
  });

  it("queues the message for the next turn when the steer is not taken", async () => {
    const { phone, send, event, status, replies, calls } = lane(false);
    phone.arrive({ id: "m1", text: "find flights to Goa" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    status("submitted");

    phone.arrive({ id: "m2", text: "only nonstop" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    event({ type: "text_delta", content: "Found 3 flights.", messageId: "a" });
    status("idle");

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send).toHaveBeenLastCalledWith("w", "s", "only nonstop");
    expect(calls).toContainEqual({ action: "ack", message_ids: ["m1"] });
    expect(replies()).toEqual([
      { action: "reply", message_id: "m1", text: "Found 3 flights." },
    ]);
    phone.stop();
  });
});
afterAll(() => {
  rmSync(fixture.home, { recursive: true, force: true });
});
