/**
 * R1-T18: bootstrap() with the memory transport, and the transport-lost
 * policy. The router is created only when boot succeeded and the transport is
 * still open (the mount guard in main.tsx), so each failure case asserts
 * `ok: false` or a closed transport.
 */
import { implement, type Router } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCollections } from "#next/data/collections";
import { FixtureDb, directDbSource } from "#next/data/fixture-db/fixture-db";
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
  RELOAD_DELAY_MS,
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
  const collections = createCollections(directDbSource(db), { backoffMs: [5] });
  open.push(
    () => transport.close(),
    async () => {
      for (const collection of Object.values(collections))
        await collection.cleanup().catch(() => undefined);
    }
  );
  return { transport, collections, db, ready, lost: vi.fn() };
};

const run = (
  s: ReturnType<typeof setup>,
  getTransport: () => Promise<MemoryTransport> = async () => s.transport,
  timeouts = { transport: 100, system: 100, prefs: 200 }
) =>
  bootstrap({
    getTransport,
    queryClient: createQueryClient(),
    getCollections: () => s.collections,
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
    expect(s.ready).toEqual([expect.objectContaining({ barrier: "failed" })]);
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

  it("ignores our own explicit close", () => {
    const { deps: d } = deps();
    createTransportLostHandler(d)("explicit");
    expect(d.stopSyncs).not.toHaveBeenCalled();
  });
});
