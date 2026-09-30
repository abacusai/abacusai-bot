/**
 * R1-T18: bootstrap() with the memory transport, and the transport-lost
 * policy. The router is created only when boot succeeded and the transport is
 * still open (the mount guard in main.tsx), so each failure case asserts
 * `ok: false` or a closed transport.
 */
import { implement, type Router } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDb } from "#next/data/db";
import { FixtureDb, fixtureTransport } from "#next/data/fixture-db/fixture-db";
import { createQueryClient } from "#next/data/query-client";
import {
  createMemoryTransport,
  type MemoryTransport,
} from "#next/data/transport/memory";
import { SYSTEM_INFO } from "#next/test-support/app-harness";
import { contract } from "#shared/contract";

import {
  bootstrap,
  createTransportLostHandler,
  LOOP_WINDOW_MS,
  mountWhenOpen,
  RELOAD_DELAY_MS,
  reportFailedBoot,
} from "./bootstrap";

const os = implement(contract).$context<{ ready: unknown[] }>();

const routerWith = (info: () => unknown) =>
  ({
    system: { info: os.system.info.handler(info as never) },
    window: {
      ready: os.window.ready.handler(({ input, context }) => {
        context.ready.push(input);
      }),
    },
  }) as unknown as Router<any, { ready: unknown[] }>;

const open: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const setup = (
  info: () => unknown = () => SYSTEM_INFO,
  db = new FixtureDb()
) => {
  const ready: unknown[] = [];
  const transport = createMemoryTransport(routerWith(info), { ready });
  const appDb = createDb(fixtureTransport(db), { retryDelayMs: () => 5 });
  const { collections } = appDb;
  open.push(
    () => transport.close(),
    async () => {
      for (const collection of Object.values(collections))
        await collection.cleanup().catch(() => undefined);
    }
  );
  return { transport, appDb, collections, db, ready, lost: vi.fn() };
};

const run = (
  s: ReturnType<typeof setup>,
  getTransport: () => Promise<MemoryTransport> = async () => s.transport,
  timeouts = { transport: 300, system: 2_000, prefs: 2_000 }
) =>
  bootstrap({
    getTransport,
    queryClient: createQueryClient(),
    getDb: () => s.appDb,
    onTransportLost: s.lost,
    timeouts,
  });

describe("bootstrap", () => {
  it("resolves transport, system facts and prefs", async () => {
    const s = setup();
    const result = await run(s);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.boot.system).toEqual(SYSTEM_INFO);
    expect(s.collections.prefs.status).toBe("ready");
  });

  it("fails on a transport that never answers, with no transport to tell", async () => {
    const s = setup();
    const result = await run(s, () => new Promise(() => undefined));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.step).toBe("transport");
      expect(result.transport).toBeNull();
    }
  });

  it("fails when system.info rejects, and reports failed to main", async () => {
    const s = setup(() => {
      throw new Error("boom");
    });
    const result = await run(s);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.step).toBe("system");
    await vi.waitFor(() =>
      expect(s.ready).toEqual([expect.objectContaining({ barrier: "failed" })])
    );
  });

  it("returns the failure at once when main stops answering the readiness call (Codex impl r1 #1)", async () => {
    const ready: unknown[] = [];
    const stalled = createMemoryTransport(
      {
        system: {
          info: os.system.info.handler(() => {
            throw new Error("boom");
          }),
        },
        window: {
          // Takes the call, never answers: the port stays open.
          ready: os.window.ready.handler(({ input }) => {
            ready.push(input);
            return new Promise<void>(() => undefined);
          }),
        },
      } as unknown as Router<any, { ready: unknown[] }>,
      { ready }
    );
    open.push(() => stalled.close());
    const s = setup();
    const started = Date.now();
    const result = await bootstrap({
      getTransport: async () => stalled,
      queryClient: createQueryClient(),
      getDb: () => s.appDb,
      onTransportLost: s.lost,
      timeouts: { transport: 300, system: 300, prefs: 300 },
      readyTimeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(ready).toHaveLength(1));
    // And the report itself is bounded: it settles although main never answers.
    const reported = reportFailedBoot(stalled, "again", 20);
    await expect(reported).resolves.toBeUndefined();
  });

  it("creates the collections only once the transport and system facts are in, over that transport", async () => {
    const s = setup();
    const order: string[] = [];
    const result = await bootstrap({
      getTransport: async () => {
        order.push("transport");
        return s.transport;
      },
      queryClient: createQueryClient(),
      getDb: (transport) => {
        order.push("db");
        expect(transport).toBe(s.transport);
        return s.appDb;
      },
      onTransportLost: s.lost,
    });
    expect(result.ok).toBe(true);
    expect(order).toEqual(["transport", "db"]);
  });

  it("a getDb() that throws fails boot and reports failed readiness through the open transport (Codex impl r2 #1)", async () => {
    const s = setup();
    const result = await bootstrap({
      getTransport: async () => s.transport,
      queryClient: createQueryClient(),
      getDb: () => {
        throw new Error("collections failed");
      },
      onTransportLost: s.lost,
      readyTimeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.step).toBe("prefs");
      expect(result.error.message).toContain("collections failed");
      expect(result.transport).toBe(s.transport);
    }
    await vi.waitFor(() =>
      expect(s.ready).toEqual([
        expect.objectContaining({
          barrier: "failed",
          reason: expect.stringContaining("collections failed"),
        }),
      ])
    );
  });

  it("fails when the prefs snapshot rejects", async () => {
    const db = new FixtureDb();
    db.prefs.failSnapshot = new Error("UNAVAILABLE");
    const s = setup(undefined, db);
    const result = await run(s);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.step).toBe("prefs");
  });

  it("registers the close handler before anything else is awaited", async () => {
    const db = new FixtureDb();
    const release = db.prefs.holdSnapshot();
    const s = setup(undefined, db);
    const booting = run(s, undefined, {
      transport: 100,
      system: 100,
      prefs: 300,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The port dies during prefs.preload().
    s.transport.serverPort.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.lost).toHaveBeenCalledWith("port-closed");
    release();
    await booting;
    // The mount guard: a closed transport never gets a router.
    expect(s.transport.state).toBe("closed");
  });

  it("a close after prefs but before the router (during changeLanguage) is caught by the guard", async () => {
    const s = setup();
    const result = await run(s);
    expect(result.ok).toBe(true);
    s.transport.serverPort.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.lost).toHaveBeenCalledOnce();
    expect(result.ok && result.boot.transport.state).toBe("closed");
  });
});

describe("createTransportLostHandler", () => {
  const deps = (storage = new Map<string, string>(), now = 50_000) => {
    const scheduled: Array<() => void> = [];
    return {
      scheduled,
      deps: {
        stopSyncs: vi.fn(),
        notify: vi.fn(),
        reload: vi.fn(),
        showError: vi.fn(),
        now: () => now,
        storage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => void storage.set(key, value),
        },
        schedule: (fn: () => void, ms: number) => {
          expect(ms).toBe(RELOAD_DELAY_MS);
          scheduled.push(fn);
        },
      },
    };
  };

  it("stops syncs, says so and reloads once after the delay", () => {
    const { deps: d, scheduled } = deps();
    const onLost = createTransportLostHandler(d);
    onLost("port-closed");
    onLost("port-closed");
    expect(d.stopSyncs).toHaveBeenCalledOnce();
    expect(d.notify).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect(d.reload).toHaveBeenCalledOnce();
  });

  it("shows the error screen instead of looping on a second loss within the window", () => {
    const storage = new Map<string, string>();
    const first = deps(storage, 100_000);
    createTransportLostHandler(first.deps)("port-closed");
    // The reloaded document loses its port again shortly after.
    const second = deps(storage, 100_000 + LOOP_WINDOW_MS - 1);
    createTransportLostHandler(second.deps)("port-closed");
    expect(second.deps.showError).toHaveBeenCalledOnce();
    expect(second.scheduled).toHaveLength(0);
  });

  it("stopping the syncs is final: no reopen, no snapshot, no restart on a new subscriber (Claude impl r1 #7)", async () => {
    const db = new FixtureDb();
    const appDb = createDb(fixtureTransport(db), { retryDelayMs: () => 5 });
    open.push(async () => {
      for (const collection of Object.values(appDb.collections))
        await collection.cleanup().catch(() => undefined);
    });
    await appDb.collections.prefs.preload();
    await vi.waitFor(() => expect(db.prefs.subscriberCount).toBe(1));
    const snapshots = vi.spyOn(db.prefs, "snapshot");
    const streams = vi.spyOn(db.prefs, "subscribe");

    const onLost = createTransportLostHandler({
      ...deps().deps,
      stopSyncs: () => appDb.stop(),
    });
    onLost("port-closed");
    await vi.waitFor(() => expect(db.prefs.subscriberCount).toBe(0));

    // What a mounted live query, a loader or the readiness reporter does in
    // the 1.5 s before the reload.
    const sub = appDb.collections.prefs.subscribeChanges(() => undefined);
    void appDb.collections.bots.preload();
    appDb.collections.sessions.startSyncImmediate();
    await new Promise((resolve) => setTimeout(resolve, 60));
    sub.unsubscribe();
    expect(snapshots).not.toHaveBeenCalled();
    expect(streams).not.toHaveBeenCalled();
    expect(db.bots.subscriberCount).toBe(0);
    expect(appDb.stopped).toBe(true);
  });

  it("ignores our own explicit close", () => {
    const { deps: d } = deps();
    createTransportLostHandler(d)("explicit");
    expect(d.stopSyncs).not.toHaveBeenCalled();
  });
});

describe("mountWhenOpen (Codex impl r2 #2)", () => {
  /** A held dev-hooks import: resolves only when released. */
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { prepare: () => gate, release };
  };

  const lostHandler = (storage: Map<string, string>, now: number) => {
    const screens: string[] = [];
    const onLost = createTransportLostHandler({
      stopSyncs: vi.fn(),
      // No Toaster before the mount: the connection-lost screen renders.
      notify: () => screens.push("connection-lost"),
      reload: vi.fn(),
      showError: () => screens.push("error"),
      now: () => now,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => void storage.set(key, value),
      },
      schedule: () => undefined,
    });
    return { screens, onLost };
  };

  it("mounts when the transport stays open", async () => {
    const s = setup();
    const mount = vi.fn();
    const gate = held();
    const mounting = mountWhenOpen({
      transport: s.transport,
      prepare: gate.prepare,
      mount,
    });
    gate.release();
    await expect(mounting).resolves.toBe(true);
    expect(mount).toHaveBeenCalledOnce();
  });

  it("never mounts over the connection-lost screen when the port dies during the held import", async () => {
    const s = setup();
    const { screens, onLost } = lostHandler(new Map(), 200_000);
    s.transport.onClose(onLost);
    const mount = vi.fn(() => screens.push("app"));
    const gate = held();
    const mounting = mountWhenOpen({
      transport: s.transport,
      prepare: gate.prepare,
      mount,
    });
    s.transport.serverPort.close();
    await vi.waitFor(() => expect(screens).toEqual(["connection-lost"]));
    gate.release();
    await expect(mounting).resolves.toBe(false);
    expect(mount).not.toHaveBeenCalled();
    expect(screens).toEqual(["connection-lost"]);
  });

  it("never mounts over the error screen on a second loss within the window during the held import", async () => {
    const storage = new Map<string, string>();
    // The first document lost its port and reloaded.
    lostHandler(storage, 300_000).onLost("port-closed");
    const s = setup();
    const { screens, onLost } = lostHandler(
      storage,
      300_000 + LOOP_WINDOW_MS - 1
    );
    s.transport.onClose(onLost);
    const mount = vi.fn(() => screens.push("app"));
    const gate = held();
    const mounting = mountWhenOpen({
      transport: s.transport,
      prepare: gate.prepare,
      mount,
    });
    s.transport.serverPort.close();
    await vi.waitFor(() => expect(screens).toEqual(["error"]));
    gate.release();
    await expect(mounting).resolves.toBe(false);
    expect(mount).not.toHaveBeenCalled();
    expect(screens).toEqual(["error"]);
  });

  it("does not start the import on an already closed transport", async () => {
    const s = setup();
    s.transport.serverPort.close();
    await vi.waitFor(() => expect(s.transport.state).toBe("closed"));
    const prepare = vi.fn(async () => undefined);
    const mount = vi.fn();
    await expect(
      mountWhenOpen({ transport: s.transport, prepare, mount })
    ).resolves.toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });
});
