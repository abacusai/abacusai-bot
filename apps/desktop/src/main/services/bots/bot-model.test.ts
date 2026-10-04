/**
 * R3-T28 (main side, spec 03 §24.10): main resolves, persists and applies a
 * bot's effective model: at every start (the relay's `start`, which calls
 * `pinSession` first as `ServiceHost`'s does), at every admission on a
 * running agent (the relay's `beforeRun`), and on a `bot.model` change for
 * every session the bot owns, a reset to null included.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSessionStatus, SessionOwner } from "@abacus-ai/contract/contracts";
import { resolveConfiguredModel, type ModelAvailability } from "@abacus-ai/contract/models";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import { AguiRelayService } from "../agui/relay-service";
import { ThreadStore } from "../session/thread-store";
import { BotService } from "./bot-service";
import { recordSenderSession, senderSessionKey } from "./bot-store";
import { effectiveBotModel } from "./effective-model";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-model-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const model = (
  id: string,
  configured: boolean,
  extra: Partial<ModelAvailability> = {}
): ModelAvailability => ({
  id,
  label: id,
  provider: id.split("/")[0]!,
  tier: "default",
  configured,
  ...extra,
});

interface SessionRecord {
  workspaceId: string;
  owner: SessionOwner | null;
  model: string | null;
  status: AgentSessionStatus;
}

/**
 * A main with the pieces the requirement spans: the session registry, the
 * stored app default, the catalog, the bot service and the relay, wired as
 * `ServiceHost` wires them.
 */
const makeMain = () => {
  const sessions = new Map<string, SessionRecord>();
  const settings: { defaultModel: string | null } = { defaultModel: null };
  let catalog: ModelAvailability[] = [
    model("abacus/route-llm", true, { recommended: true }),
    model("openllm/auto", true),
    model("deepseek/deepseek-v4-flash", true),
  ];
  const written: Array<{
    sessionId: string;
    command: Record<string, unknown>;
  }> = [];
  const startedWith: Array<{ sessionId: string; model: string | null }> = [];
  const updates: Array<{ sessionId: string; model: string }> = [];
  let counter = 0;
  let runtime = {};
  /** The catalog read; a test can hold it to order two resolutions. */
  let catalogRead: () => Promise<ModelAvailability[]> = async () => catalog;

  const bots: BotService = new BotService({
    resolveDefaultWorkspaceId: () => "ws",
    isWorkspaceUsable: () => true,
    sessionExists: (_ws, id) => sessions.has(id),
    createSession: (workspaceId, owner) => {
      const id = `s-${++counter}`;
      sessions.set(id, { workspaceId, owner, model: null, status: "stopped" });
      return { id };
    },
    findOwnedSession: () => null,
    updateSessionLabel: () => undefined,
    // The real start handler reads the session's pinned model.
    startSession: async (_ws, sessionId) => {
      await start(sessionId);
      return { success: true };
    },
    sendMessage: () => undefined,
    removeSession: () => undefined,
    // As ServiceHost: persist, and a running agent takes it now.
    updateSessionModel: (_ws, sessionId, next) => {
      updates.push({ sessionId, model: next });
      const session = sessions.get(sessionId);
      if (session == null) return;
      session.model = next;
      if (session.status === "running")
        written.push({
          sessionId,
          command: { type: "set_model", model: next },
        });
    },
    effectiveModel: (requested, pinned) =>
      effectiveBotModel(
        requested,
        {
          readDefault: () => settings.defaultModel,
          listCatalog: async () => catalogRead(),
          cachedRecommended: () => "abacus/route-llm",
        },
        pinned
      ),
    sessionInfo: (sessionId) => {
      const session = sessions.get(sessionId);
      return session == null
        ? null
        : {
            workspaceId: session.workspaceId,
            owner: session.owner,
            model: session.model,
          };
    },
    emitChanged: () => undefined,
  });

  // `ServiceHost`'s relay `start`: pin, then start on the session's model.
  const start = async (sessionId: string): Promise<boolean> => {
    await bots.pinSession(sessionId);
    const session = sessions.get(sessionId);
    if (session == null) return false;
    startedWith.push({ sessionId, model: session.model });
    session.status = "running";
    runtime = {};
    relay.ingest(
      sessionId,
      {
        type: "CUSTOM",
        name: "wire.hello",
        value: { protocol: 1, wire: "agui", compat: "fd", incarnation: "i" },
      },
      { wire: "agui", runtime }
    );
    return true;
  };

  const relay: AguiRelayService = new AguiRelayService({
    host: {
      workspaceOf: (id) => sessions.get(id)?.workspaceId ?? null,
      runtime: (id) => {
        const session = sessions.get(id);
        return session == null || session.status === "stopped"
          ? null
          : { wire: "agui", status: session.status };
      },
      start,
      send: (sessionId, command) => {
        const typed = command as Record<string, unknown>;
        written.push({ sessionId, command: typed });
        const runId = (typed.input as { runId?: string } | undefined)?.runId;
        if (typed.type === "run" && runId != null)
          queueMicrotask(() =>
            relay.ingest(
              sessionId,
              {
                type: "CUSTOM",
                name: "run.ack",
                value: { runId, status: "started" },
              },
              { wire: "agui", runtime }
            )
          );
        return runtime;
      },
      markSent: () => undefined,
      markStopped: () => undefined,
      // `ServiceHost.applyEffectiveBotModel`.
      beforeRun: async (sessionId) => {
        await bots.pinSession(sessionId);
      },
    },
    files: new ThreadStore({ home: () => home, log: () => undefined }),
    startTimeoutMs: 1_000,
    ackTimeoutMs: 1_000,
    log: () => undefined,
  });

  const send = (sessionId: string, runId: string) =>
    relay.send({
      threadId: sessionId,
      runId,
      messages: [
        {
          id: `${runId}:u`,
          role: "user",
          parts: [{ type: "text", content: "hi" }],
        },
      ],
    });

  return {
    bots,
    updates,
    relay,
    sessions,
    settings,
    written,
    startedWith,
    send,
    setCatalog: (next: ModelAvailability[]) => {
      catalog = next;
    },
    setCatalogRead: (read: () => Promise<ModelAvailability[]>) => {
      catalogRead = read;
    },
    stop: (sessionId: string) => {
      sessions.get(sessionId)!.status = "stopped";
    },
  };
};

describe("the effective bot model in main (spec 03 §24.10)", () => {
  it("a reset to null on a stopped session starts with the app default through the start handler", async () => {
    const main = makeMain();
    main.settings.defaultModel = "openllm/auto";
    const bot = main.bots.create({
      name: "Scout",
      description: "Watch.",
      model: "deepseek/deepseek-v4-flash",
    });
    const handle = await main.bots.openChat(bot.id);
    expect(main.startedWith).toEqual([
      { sessionId: handle.sessionId, model: "deepseek/deepseek-v4-flash" },
    ]);
    main.stop(handle.sessionId);

    main.bots.update(bot.id, { model: null });
    await main.bots.settled();
    // Persisted on the (stopped) session: no live command to a dead agent.
    expect(main.sessions.get(handle.sessionId)!.model).toBe("openllm/auto");
    expect(
      main.written.filter((entry) => entry.command.type === "set_model")
    ).toEqual([]);

    await main.send(handle.sessionId, "run-1");
    expect(main.startedWith.at(-1)).toEqual({
      sessionId: handle.sessionId,
      model: "openllm/auto",
    });
  });

  it("an app-default change reaches a null-model bot whose renderer holds a cached openChat handle", async () => {
    const main = makeMain();
    main.settings.defaultModel = "openllm/auto";
    const bot = main.bots.create({ name: "Scout", description: "Watch." });
    const handle = await main.bots.openChat(bot.id);
    expect(main.sessions.get(handle.sessionId)!.model).toBe("openllm/auto");

    // The default moves; the renderer's cached handle skips openChat.
    main.settings.defaultModel = "deepseek/deepseek-v4-flash";
    main.written.length = 0;
    await expect(main.send(handle.sessionId, "run-2")).resolves.toMatchObject({
      status: "started",
    });

    // set_model reaches the running agent before the run is written.
    expect(main.written.map((entry) => entry.command.type)).toEqual([
      "set_model",
      "run",
    ]);
    expect(main.written[0]!.command.model).toBe("deepseek/deepseek-v4-flash");
    expect(main.sessions.get(handle.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );

    // Unchanged: nothing extra is written at the next admission.
    main.written.length = 0;
    await main.send(handle.sessionId, "run-3");
    expect(main.written.map((entry) => entry.command.type)).toEqual(["run"]);
  });

  it("a bot.model change re-pins every session the bot owns and applies it to running ones; reused sender chats re-pin on open", async () => {
    const main = makeMain();
    main.settings.defaultModel = "openllm/auto";
    const bot = main.bots.create({ name: "Scout", description: "Watch." });
    const forever = await main.bots.openChat(bot.id);
    const sender = await main.bots.openSenderChat(
      bot.id,
      "telegram",
      "c1",
      "Ann"
    );
    main.stop(sender.sessionId);

    main.bots.update(bot.id, { model: "deepseek/deepseek-v4-flash" });
    await main.bots.settled();
    expect(main.sessions.get(forever.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );
    expect(main.sessions.get(sender.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );
    // Only the running forever chat got a live command.
    expect(
      main.written
        .filter((entry) => entry.command.type === "set_model")
        .map((entry) => entry.sessionId)
    ).toEqual([forever.sessionId]);

    // A stale pin on a reused sender chat (as left by an older build).
    main.sessions.get(sender.sessionId)!.model = "abacus/route-llm";
    recordSenderSession(senderSessionKey(bot.id, "telegram", "c1"), {
      botId: bot.id,
      workspaceId: "ws",
      sessionId: sender.sessionId,
      platform: "telegram",
      senderName: "Ann",
    });
    const reused = await main.bots.openSenderChat(
      bot.id,
      "telegram",
      "c1",
      "Ann"
    );
    expect(reused.sessionId).toBe(sender.sessionId);
    expect(main.sessions.get(sender.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );
  });

  it("a check-in run (no bot owner) keeps its own model", async () => {
    const main = makeMain();
    main.sessions.set("run-session", {
      workspaceId: "ws",
      owner: null,
      model: "abacus/route-llm",
      status: "stopped",
    });
    expect(await main.bots.pinSession("run-session")).toBeNull();
    expect(main.sessions.get("run-session")!.model).toBe("abacus/route-llm");
  });

  it("a removed credential and a stored default missing from the catalog resolve to the same model in the renderer and in main", async () => {
    const main = makeMain();
    // The bot's model lost its key; the stored default names a retired id.
    const catalog = [
      model("abacus/route-llm", true, { recommended: true }),
      model("openllm/auto", false),
      model("deepseek/deepseek-v4-flash", true),
    ];
    main.setCatalog(catalog);
    main.settings.defaultModel = "gone/model-x";
    const bot = main.bots.create({
      name: "Scout",
      description: "Watch.",
      model: "openllm/auto",
    });

    // What the renderer's chip shows (the same shared resolver, same inputs).
    const displayed = resolveConfiguredModel({
      requested: "openllm/auto",
      defaultModel: "gone/model-x",
      catalog,
    });
    const handle = await main.bots.openChat(bot.id);
    expect(displayed).toBe("abacus/route-llm");
    expect(main.startedWith).toEqual([
      { sessionId: handle.sessionId, model: displayed },
    ]);

    // Nothing configured at all: nothing is pinned, and both say null.
    main.setCatalog(catalog.map((entry) => ({ ...entry, configured: false })));
    expect(
      resolveConfiguredModel({
        requested: null,
        defaultModel: null,
        catalog: catalog.map((entry) => ({ ...entry, configured: false })),
      })
    ).toBeNull();
    expect(await main.bots.pinSession(handle.sessionId)).toBeNull();
  });

  it("two quick bot.model edits whose catalog reads resolve in reverse order leave every session on the latest", async () => {
    const main = makeMain();
    main.settings.defaultModel = "openllm/auto";
    const bot = main.bots.create({ name: "Scout", description: "Watch." });
    const handle = await main.bots.openChat(bot.id);
    main.written.length = 0;

    // Each catalog read waits until the test lets it go.
    const reads: Array<() => void> = [];
    main.setCatalogRead(
      () =>
        new Promise((resolve) => {
          reads.push(() =>
            resolve([
              model("abacus/route-llm", true, { recommended: true }),
              model("openllm/auto", true),
              model("deepseek/deepseek-v4-flash", true),
            ])
          );
        })
    );
    main.bots.update(bot.id, { model: "abacus/route-llm" });
    main.bots.update(bot.id, { model: "deepseek/deepseek-v4-flash" });
    let done = false;
    void main.bots.settled().then(() => (done = true));
    // Newest read first, as a slow catalog for the first edit would.
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const release of reads.splice(0).reverse()) release();
    }

    expect(main.sessions.get(handle.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );
    expect(
      main.written.filter((entry) => entry.command.type === "set_model").at(-1)
        ?.command.model
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("a session deleted while its model resolves takes no pin", async () => {
    const main = makeMain();
    main.settings.defaultModel = "openllm/auto";
    const bot = main.bots.create({ name: "Scout", description: "Watch." });
    const handle = await main.bots.openChat(bot.id);
    main.updates.length = 0;
    let release: () => void = () => undefined;
    main.setCatalogRead(
      () =>
        new Promise((resolve) => {
          release = () => resolve([model("deepseek/deepseek-v4-flash", true)]);
        })
    );
    main.bots.update(bot.id, { model: "deepseek/deepseek-v4-flash" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    main.sessions.delete(handle.sessionId);
    release();
    await main.bots.settled();
    expect(main.updates).toEqual([]);
  });

  it("an empty, unreadable or partial (offline) catalog keeps the stored pin; only a credential the catalog says is gone moves it", async () => {
    const main = makeMain();
    const bot = main.bots.create({
      name: "Scout",
      description: "Watch.",
      model: "deepseek/deepseek-v4-flash",
    });
    const handle = await main.bots.openChat(bot.id);
    expect(main.sessions.get(handle.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );

    main.setCatalog([]);
    await main.bots.pinSession(handle.sessionId);
    main.setCatalogRead(async () => {
      throw new Error("offline");
    });
    await main.bots.pinSession(handle.sessionId);
    // Offline: the paid row is simply not listed.
    main.setCatalogRead(async () => [
      model("abacus/route-llm", true, { recommended: true }),
    ]);
    await main.bots.pinSession(handle.sessionId);
    expect(main.sessions.get(handle.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );
    expect(
      main.updates.filter((entry) => entry.sessionId === handle.sessionId)
    ).toEqual([
      { sessionId: handle.sessionId, model: "deepseek/deepseek-v4-flash" },
    ]);

    // Authoritative: the row is there and its credential is gone.
    main.setCatalogRead(async () => [
      model("abacus/route-llm", true, { recommended: true }),
      model("deepseek/deepseek-v4-flash", false),
    ]);
    await main.bots.pinSession(handle.sessionId);
    expect(main.sessions.get(handle.sessionId)!.model).toBe("abacus/route-llm");
  });

  it("a new bot chat with an empty catalog is still pinned, to the synchronous default", async () => {
    const main = makeMain();
    main.setCatalog([]);
    main.settings.defaultModel = "openllm/auto";
    const explicit = main.bots.create({
      name: "Ada",
      description: "Counts",
      model: "deepseek/deepseek-v4-flash",
    });
    const plain = main.bots.create({ name: "Bo", description: "Counts" });
    const a = await main.bots.openChat(explicit.id);
    const b = await main.bots.openChat(plain.id);
    expect(main.sessions.get(a.sessionId)!.model).toBe(
      "deepseek/deepseek-v4-flash"
    );
    expect(main.sessions.get(b.sessionId)!.model).toBe("openllm/auto");
    main.settings.defaultModel = null;
    const c = await main.bots.openChat(
      main.bots.create({ name: "Cy", description: "Counts" }).id
    );
    // The tier's cached recommendation.
    expect(main.sessions.get(c.sessionId)!.model).toBe("abacus/route-llm");
  });

  it("RPC agent.start (the real handler) starts a bot session on its effective model, not the remembered pin", async () => {
    const main = makeMain();
    main.settings.defaultModel = "openllm/auto";
    const bot = main.bots.create({ name: "Scout", description: "Watch." });
    const handle = await main.bots.openChat(bot.id);
    main.stop(handle.sessionId);
    // The app default moves while the chat is stopped.
    main.settings.defaultModel = "deepseek/deepseek-v4-flash";

    const startAgentSession = vi.fn(async (request: object) => ({
      success: true,
      created: false,
      state: request,
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const connection = connectInProcess(
      fakeDeps({
        serviceHost: {
          listAllAgentSessions: () =>
            [...main.sessions].map(([id, session]) => ({
              id,
              workspaceId: session.workspaceId,
              model: session.model,
              mode: null,
            })),
          startAgentSession,
          // `ServiceHost.applyEffectiveBotModel`.
          applyEffectiveBotModel: async (sessionId: string) => {
            await main.bots.pinSession(sessionId);
          },
        },
      })
    );
    try {
      await connection.client.agent.start({
        workspaceId: "ws",
        sessionId: handle.sessionId,
      });
    } finally {
      connection.closeClient();
      connection.closeServer();
      vi.restoreAllMocks();
    }
    expect(startAgentSession).toHaveBeenLastCalledWith({
      workspaceId: "ws",
      sessionId: handle.sessionId,
      model: "deepseek/deepseek-v4-flash",
    });
  });
});
