/**
 * A-T2: the real router over a real MessageChannel with the real oRPC
 * adapters, main's services faked. Round trips, validation, mapped errors,
 * bytes, and iterators ending (their bus listeners with them) when the
 * client aborts or the port closes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IpcEvent } from "#shared/contracts";

import { MainEventBus } from "../event-bus";
import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "../testing";

const connections: InProcessConnection[] = [];
const connect = (...args: Parameters<typeof connectInProcess>) => {
  const connection = connectInProcess(...args);
  connections.push(connection);
  return connection;
};

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const at = new Date(0).toISOString();

describe("the router over a MessagePort (A-T2)", () => {
  it("round-trips a query to the same ServiceHost method IPC uses", async () => {
    const getSessionTurnState = vi.fn(() => ({
      sessionId: "s1",
      workspaceId: "w1",
      phase: "idle" as const,
      isBusy: false,
      updatedAt: at,
    }));
    const { client } = connect(
      fakeDeps({ serviceHost: { getSessionTurnState } })
    );

    await expect(
      client.sessions.turnState({ workspaceId: "w1", sessionId: "s1" })
    ).resolves.toMatchObject({ phase: "idle" });
    expect(getSessionTurnState).toHaveBeenCalledWith("w1", "s1");
  });

  it("runs a mutation with the named input the legacy call took positionally", async () => {
    const setAgentMode = vi.fn();
    const { client } = connect(fakeDeps({ serviceHost: { setAgentMode } }));

    await client.agent.setMode({
      workspaceId: "w1",
      sessionId: "s1",
      mode: "PLAN" as never,
    });

    expect(setAgentMode).toHaveBeenCalledWith({
      workspaceId: "w1",
      sessionId: "s1",
      mode: "PLAN",
    });
  });

  it("refuses input that fails the contract with BAD_REQUEST", async () => {
    const getSessionTurnState = vi.fn();
    const { client } = connect(
      fakeDeps({ serviceHost: { getSessionTurnState } })
    );

    await expect(
      client.sessions.turnState({ workspaceId: "../etc", sessionId: "s1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", defined: true });
    expect(getSessionTurnState).not.toHaveBeenCalled();
  });

  it("maps a legacy failure result onto a defined error", async () => {
    const { client } = connect(
      fakeDeps({
        app: {
          readFileAsText: async () => ({ success: false, error: "not-found" }),
        },
        serviceHost: {
          addWorkspace: async () => ({ success: false, error: "not a folder" }),
        },
      })
    );

    await expect(
      client.files.readText({ filePath: "a.txt", hostRoot: "/w" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      defined: true,
      data: { entity: "file", id: "a.txt" },
    });
    await expect(
      client.workspaces.add({ path: "/nope" })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "not a folder" },
    });
  });

  it("keeps a thrown service error's message", async () => {
    const { client } = connect(
      fakeDeps({
        host: {
          saveApiKey: async () => {
            throw new Error("unidentified-account");
          },
        },
      })
    );

    await expect(
      client.settings.keys.save({ provider: "abacus", key: "k" })
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "unidentified-account",
    });
  });

  it("carries bytes both ways as Uint8Array", async () => {
    const savePastedTempFiles = vi.fn(async () => ({
      success: true,
      dir: "/w/.abacusai-bot/temp",
      paths: ["/w/.abacusai-bot/temp/a.png"],
    }));
    const openFilesDialog = vi.fn(async () => [
      {
        path: "/w/b.bin",
        name: "b.bin",
        data: Buffer.from([1, 2, 3, 255]),
        mimeType: "application/octet-stream",
      },
    ]);
    const { client } = connect(
      fakeDeps({ app: { savePastedTempFiles, openFilesDialog } })
    );

    await client.files.savePastedTemp({
      baseFolder: "/w",
      files: [{ name: "a.png", data: new Uint8Array([9, 8, 7]) }],
    });
    const sent = savePastedTempFiles.mock.calls[0] as unknown as [
      string,
      Array<{ data: Uint8Array }>,
    ];
    expect(sent[1][0]!.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent[1][0]!.data)).toEqual([9, 8, 7]);

    const picked = await client.system.dialog.openFiles({ kind: "all" });
    expect(Buffer.isBuffer(picked![0]!.data)).toBe(false);
    expect(Array.from(picked![0]!.data)).toEqual([1, 2, 3, 255]);
  });

  it("delivers bus events to an iterator, filtered and mapped", async () => {
    const bus = new MainEventBus();
    const { client } = connect(fakeDeps({ bus }));

    const iterator = await client.bots.events();
    await vi.waitFor(() => expect(bus.listenerCount()).toBeGreaterThan(1));
    bus.dispatch({ type: "messaging-updated", emittedAt: at } as IpcEvent);
    bus.dispatch({ type: "bots-updated", emittedAt: at } as IpcEvent);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "previews-changed" },
    });
    await iterator.return();
  });

  it("runs the iterator's cleanup when the client aborts it", async () => {
    const bus = new MainEventBus();
    const baseline = bus.listenerCount();
    const { client } = connect(fakeDeps({ bus }));
    const controller = new AbortController();

    const iterator = await client.settings.events(undefined, {
      signal: controller.signal,
    });
    const pending = iterator.next();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 1 + 1));

    controller.abort();
    await pending.catch(() => undefined);
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 1));
  });

  it("ends every open iterator when the port closes", async () => {
    const bus = new MainEventBus();
    const deps = fakeDeps({ bus });
    // The device-build tracker is one permanent listener.
    const baseline = bus.listenerCount();
    const connection = connect(deps);

    const iterators = await Promise.all([
      connection.client.bots.events(),
      connection.client.settings.events(),
      connection.client.files.events(),
      connection.client.messaging.events(),
    ]);
    const reads = iterators.map((iterator) =>
      iterator.next().catch(() => undefined)
    );
    await vi.waitFor(() =>
      expect(bus.listenerCount()).toBe(baseline + iterators.length)
    );

    // A reload, a swap flip or a closed window closes the renderer's end.
    connection.closeClient();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline));
    await Promise.all(reads);
  });

  it("answers UNAVAILABLE for what later slices serve", async () => {
    const { client } = connect(fakeDeps());

    await expect(
      client.ai.send({ threadId: "s1", runId: "r1", messages: [] })
    ).rejects.toMatchObject({ code: "UNAVAILABLE", defined: true });
    await expect(client.ai.subscribe({ threadId: "s1" })).rejects.toMatchObject(
      { code: "UNAVAILABLE" }
    );
    await expect(client.db.bots.snapshot()).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("keeps the browser runtime to the main renderer, as its IPC does", async () => {
    const present = vi.fn(() => ({}));
    const lease = {
      conversationKey: '["conversation",1,"w1","draft"]',
      resourceId: "r1",
      generation: 1,
    } as never;
    const request = {
      lease,
      presentationId: "p1",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    };

    const other = connect(
      fakeDeps({
        browserRuntime: { present },
        windows: { mainRendererId: () => 99 },
      }),
      { webContentsId: 7 }
    );
    await expect(
      other.client.browser.runtime.present(request)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const main = connect(
      fakeDeps({
        browserRuntime: { present },
        windows: { mainRendererId: () => 7 },
      }),
      { webContentsId: 7 }
    );
    await main.client.browser.runtime.present(request);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it("serves the caller's window chrome and streams its changes", async () => {
    const bus = new MainEventBus();
    const chrome = {
      mode: "overlay" as const,
      fullScreen: false,
      density: "comfortable" as const,
      toolbarHeight: 40,
    };
    const state = { fullScreen: false, focused: true, maximized: false };
    const { client } = connect(
      fakeDeps({
        bus,
        windows: {
          chrome: (id) => (id === 3 ? chrome : null),
          state: (id) => (id === 3 ? state : null),
        },
      }),
      { webContentsId: 3 }
    );

    await expect(client.window.chrome()).resolves.toEqual(chrome);

    const events = await client.window.events();
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "state", state },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "chrome", chrome },
    });
    await vi.waitFor(() => expect(bus.listenerCount()).toBeGreaterThan(1));
    // Another window's change is not this one's.
    bus.dispatchChannel("window", {
      webContentsId: 4,
      event: { type: "chrome", chrome: { ...chrome, density: "compact" } },
    });
    bus.dispatchChannel("window", {
      webContentsId: 3,
      event: { type: "chrome", chrome: { ...chrome, fullScreen: true } },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "chrome",
        chrome: { fullScreen: true, density: "comfortable" },
      },
    });
    await events.return();
  });

  it("serves system.info from the same sources the preload read", async () => {
    const { client } = connect(
      fakeDeps({
        app: {
          appVersion: () => "1.0.12",
          homeDir: () => "/Users/ada",
          botHome: () => "/Users/ada/.abacusai-bot",
        },
        host: { sessionHomePath: () => "/Users/ada/AbacusAI" },
        serviceHost: {
          getMetadata: () => ({ materialIconsBasePath: "/icons" }),
        },
      })
    );

    await expect(client.system.info()).resolves.toMatchObject({
      appVersion: "1.0.12",
      platform: process.platform,
      homeDir: "/Users/ada",
      paths: { sessionHome: "/Users/ada/AbacusAI" },
      materialIconsBasePath: "/icons",
      contractVersion: 1,
    });
  });
});
