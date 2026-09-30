/**
 * Spec 07 review r1 #9: an experience whose renderer never passes the swap's
 * readiness barrier is never persisted as active. The swap scheduler's
 * `gave-up` rolls this process back and remembers the candidate as rejected;
 * a full restart (a new store reading the pointers) boots the committed
 * experience, and a crash before readiness does too. A candidate that
 * becomes ready is committed with the old one as `previous`.
 *
 * The swaps here go through the real `RendererHost` with the barrier this
 * shell ships (`first-commit` at FOUNDATION_API 1): only its webContents are
 * fakes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ userData: "", appVersion: "1.0.0" }));

const fakes = vi.hoisted(() => {
  const behaviour = {
    /** Documents whose URL starts with one of these never signal ready. */
    silent: [] as string[],
    /** Documents whose URL starts with one of these fail to load. */
    failing: [] as string[],
    hanging: [] as string[],
  };
  let nextId = 1;

  class FakeWebContents {
    readonly id = nextId++;
    destroyed = false;
    url = "";
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly close = (): void => {
      this.destroyed = true;
    };
    readonly executeJavaScript = async (): Promise<null> => null;
    readonly focus = (): void => undefined;
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isFocused(): boolean {
      return false;
    }
    getURL(): string {
      return this.url;
    }
    async loadURL(url: string): Promise<void> {
      if (behaviour.hanging.some((prefix) => url.startsWith(prefix)))
        await new Promise<void>(() => {});
      if (behaviour.failing.some((prefix) => url.startsWith(prefix)))
        throw new Error("ERR_FILE_NOT_FOUND");
      this.url = url;
      if (!behaviour.silent.some((prefix) => url.startsWith(prefix)))
        queueMicrotask(() => this.emit("ipc-message", {}, "renderer-ready"));
    }
    on(event: string, listener: (...args: unknown[]) => void): void {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
    }
    off(event: string, listener: (...args: unknown[]) => void): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== listener)
      );
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class FakeWebContentsView {
    bounds = { height: 0, width: 0, x: 0, y: 0 };
    readonly webContents = new FakeWebContents();
    getBounds() {
      return this.bounds;
    }
    setBackgroundColor(): void {}
    setBounds(bounds: { height: number; width: number; x: number; y: number }) {
      this.bounds = bounds;
    }
  }

  class FakeWindow {
    readonly children: FakeWebContentsView[] = [];
    destroyed = false;
    readonly contentView = {
      addChildView: (view: FakeWebContentsView, index?: number) => {
        this.children.splice(index ?? this.children.length, 0, view);
      },
      children: this.children,
      removeChildView: (view: FakeWebContentsView) => {
        const at = this.children.indexOf(view);
        if (at !== -1) this.children.splice(at, 1);
      },
    };
    getContentBounds() {
      return { height: 600, width: 800, x: 0, y: 0 };
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    on(): void {}
  }

  return { behaviour, FakeWebContentsView, FakeWindow };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => paths.userData,
    getVersion: () => paths.appVersion,
    getAppPath: () => paths.userData,
    isPackaged: false,
  },
  WebContentsView: fakes.FakeWebContentsView,
}));

// The tree check is integrity.test.ts's; here a directory with a
// `manifest.json` is an intact experience of that version.
vi.mock("./integrity", () => ({
  verifyExperience: async (directory: string) =>
    JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")),
}));

const { ExperienceStore, REJECTION_TTL_MS } =
  await import("./experience-store");
const { rendererChangeNeedsReadiness } = await import("./experience-updater");
const { rendererUrl } = await import("./app-protocol");
const { FOUNDATION_API } = await import("#shared/experience");
const {
  MAX_SWAP_READINESS_ATTEMPTS,
  RendererHost,
  RendererSwapScheduler,
  SwapNotReady,
} = await import("../../../renderer-host");

type Store = InstanceType<typeof ExperienceStore>;
type Outcome = import("../../../renderer-host").SwapOutcome;

const VERSION = (n: number) => String(n).repeat(64).slice(0, 64);
const SHA = (n: number) => `${"f".repeat(63)}${n}`;
/** The barrier index.ts derives from the shipped FOUNDATION_API. */
const SHIPPED_BARRIER = FOUNDATION_API >= 2 ? "subscriptions" : "first-commit";

beforeEach(() => {
  paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), "experience-"));
  paths.appVersion = "1.0.0";
  fakes.behaviour.silent = [];
  fakes.behaviour.failing = [];
  fakes.behaviour.hanging = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(paths.userData, { recursive: true, force: true });
});

/** An installed tree for version `n` with renderer `renderer`. */
const installTree = (store: Store, n: number, renderer = `renderer-${n}`) => {
  const manifest = {
    experienceVersion: VERSION(n),
    rendererVersion: renderer,
    agentVersion: `agent-${n}`,
    files: {},
    foundation: "1.0.0",
    foundationApi: 2,
    protocol: "1",
  };
  const directory = path.join(store.experiencesDirectory, VERSION(n));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest)
  );
  return store.install(manifest as never, SHA(n));
};

const restart = async () => {
  const store = new ExperienceStore();
  await store.initialize();
  return store;
};

const makeHost = () =>
  new RendererHost({
    backgroundColor: "#000",
    webPreferences: {},
    window: new fakes.FakeWindow() as never,
    wire: () => undefined,
  });

/** index.ts's wiring: the store settles on the scheduler's outcomes. */
const wire = (
  store: Store,
  host: () => InstanceType<typeof RendererHost> | null
) => {
  const outcomes: Array<{ version: string; outcome: Outcome; live?: boolean }> =
    [];
  const settled: Promise<void>[] = [];
  const scheduler = new RendererSwapScheduler({
    target: (version) =>
      store.version === version ? rendererUrl(version) : null,
    host,
    busy: () => false,
    barrier: SHIPPED_BARRIER,
    pollMs: 1_000,
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onOutcome: (version, outcome, detail) => {
      outcomes.push({ version, outcome, ...detail });
      settled.push(
        outcome === "gave-up"
          ? store.abandonActivation(version)
          : store.commitActivation(version)
      );
    },
  });
  return {
    scheduler,
    outcomes,
    settle: () => Promise.all(settled),
  };
};

describe("experience activation is transactional with renderer readiness", () => {
  it("with the shipped barrier, a candidate that never signals ready is rolled back and rejected, and a restart boots the previous one", async () => {
    vi.useFakeTimers();
    const store = await restart();
    await store.activate(installTree(store, 1));
    expect(store.version).toBe(VERSION(1));

    // A new renderer: live in this process, not persisted yet.
    await store.activate(installTree(store, 2), { commit: false });
    expect(store.version).toBe(VERSION(2));
    expect((await restart()).version).toBe(VERSION(1));

    const host = makeHost();
    const first = host.webContents;
    fakes.behaviour.silent = [rendererUrl(VERSION(2)).href];
    const { scheduler, outcomes, settle } = wire(store, () => host);
    scheduler.schedule(VERSION(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcomes).toEqual([{ version: VERSION(2), outcome: "gave-up" }]);
    await settle();
    expect(store.version).toBe(VERSION(1));
    // Never flipped in.
    expect(host.webContents).toBe(first);
    vi.useRealTimers();

    // A full restart: the rejected candidate does not boot, and stays rejected.
    const relaunched = await restart();
    expect(relaunched.version).toBe(VERSION(1));
    expect(await relaunched.isRejected(VERSION(2), SHA(2))).toBe(true);
    expect(await relaunched.isRejected(VERSION(1), SHA(1))).toBe(false);
  });

  it("with the shipped barrier, a candidate that signals ready is swapped in and committed", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    const host = makeHost();
    const { scheduler, outcomes, settle } = wire(store, () => host);

    scheduler.schedule(VERSION(2));
    await vi.waitFor(() =>
      expect(outcomes).toEqual([{ version: VERSION(2), outcome: "swapped" }])
    );
    await settle();
    expect(host.webContents.getURL()).toBe(rendererUrl(VERSION(2)).href);
    expect((await restart()).version).toBe(VERSION(2));
  });

  it.each(["failing", "hanging"] as const)(
    "a %s load is retried within the budget, then gives up",
    async (mode) => {
      vi.useFakeTimers();
      const store = await restart();
      await store.activate(installTree(store, 1));
      await store.activate(installTree(store, 2), { commit: false });
      const host = makeHost();
      const swap = vi.spyOn(host, "swap");
      fakes.behaviour[mode] = [rendererUrl(VERSION(2)).href];
      const { scheduler, outcomes, settle } = wire(store, () => host);

      scheduler.schedule(VERSION(2));
      await vi.advanceTimersByTimeAsync(100_000);
      expect(swap).toHaveBeenCalledTimes(MAX_SWAP_READINESS_ATTEMPTS);
      expect(outcomes).toEqual([{ version: VERSION(2), outcome: "gave-up" }]);
      expect(scheduler.pending).toBe(false);
      await settle();
      expect(store.version).toBe(VERSION(1));
      expect(store.pendingVersion).toBeNull();
    }
  );

  it("the swap's first-commit barrier rejects a candidate that never signals", async () => {
    vi.useFakeTimers();
    const host = makeHost();
    const first = host.webContents;
    fakes.behaviour.silent = ["app://silent/"];
    const swapping = host.swap(new URL("app://silent/"), {
      barrier: "first-commit",
    });
    const rejected = expect(swapping).rejects.toBeInstanceOf(SwapNotReady);
    await vi.advanceTimersByTimeAsync(6_000);
    await rejected;
    expect(host.webContents).toBe(first);
  });

  it("with no window, the activation stays pending; the next window's first document settles it", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    let host: InstanceType<typeof RendererHost> | null = null;
    const { scheduler, outcomes, settle } = wire(store, () => host);

    scheduler.schedule(VERSION(2));
    await Promise.resolve();
    // Neither committed nor rejected: waiting for a window.
    expect(outcomes).toEqual([]);
    expect(scheduler.pending).toBe(true);
    expect((await restart()).version).toBe(VERSION(1));

    // The window comes back and loads the active (candidate) bundle.
    host = makeHost();
    scheduler.adopt(host);
    await host.webContents.loadURL(rendererUrl(VERSION(2)).href);
    await vi.waitFor(() =>
      expect(outcomes).toEqual([{ version: VERSION(2), outcome: "swapped" }])
    );
    await settle();
    expect((await restart()).version).toBe(VERSION(2));
  });

  it("the next window's first document that never becomes ready gives up, live", async () => {
    vi.useFakeTimers();
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    let host: InstanceType<typeof RendererHost> | null = null;
    const { scheduler, outcomes, settle } = wire(store, () => host);
    scheduler.schedule(VERSION(2));

    fakes.behaviour.silent = [rendererUrl(VERSION(2)).href];
    host = makeHost();
    scheduler.adopt(host);
    await host.webContents.loadURL(rendererUrl(VERSION(2)).href);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(outcomes).toEqual([
      { version: VERSION(2), outcome: "gave-up", live: true },
    ]);
    await settle();
    expect(store.version).toBe(VERSION(1));
  });

  it("closing an adopted window defers activation and its old deadline cannot reject a replacement", async () => {
    vi.useFakeTimers();
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    let host: InstanceType<typeof RendererHost> | null = null;
    const { scheduler, outcomes, settle } = wire(store, () => host);
    scheduler.schedule(VERSION(2));
    fakes.behaviour.silent = [rendererUrl(VERSION(2)).href];
    host = makeHost();
    scheduler.adopt(host);
    await host.webContents.loadURL(rendererUrl(VERSION(2)).href);
    await vi.advanceTimersByTimeAsync(1_000);
    const closed = host.webContents as unknown as InstanceType<
      typeof fakes.FakeWebContentsView
    >["webContents"];
    closed.close();
    closed.emit("destroyed");
    host = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([]);
    expect(scheduler.pending).toBe(true);
    host = makeHost();
    scheduler.adopt(host);
    await host.webContents.loadURL(rendererUrl(VERSION(2)).href);
    // The first window's deadline expires before the replacement's.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(outcomes).toEqual([]);
    const replacement = host.webContents as unknown as InstanceType<
      typeof fakes.FakeWebContentsView
    >["webContents"];
    replacement.emit("ipc-message", {}, "renderer-ready");
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes).toEqual([{ version: VERSION(2), outcome: "swapped" }]);
    await settle();
    expect((await restart()).version).toBe(VERSION(2));
  });

  it("a window that goes away mid-swap leaves the activation pending, not committed", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    const swap = vi.fn(async () => false);
    const outcomes: string[] = [];
    const scheduler = new RendererSwapScheduler({
      target: (version) =>
        store.version === version ? rendererUrl(version) : null,
      host: () => ({ swap }),
      busy: () => false,
      barrier: SHIPPED_BARRIER,
      log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onOutcome: (_version, outcome) => outcomes.push(outcome),
    });
    scheduler.schedule(VERSION(2));
    await vi.waitFor(() => expect(swap).toHaveBeenCalled());
    await Promise.resolve();
    expect(outcomes).toEqual([]);
    expect(scheduler.pending).toBe(true);
    scheduler.cancel();
  });

  it("a crash before readiness boots the committed experience", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 3), { commit: false });
    // The process dies here: nothing was committed.
    expect((await restart()).version).toBe(VERSION(1));
  });

  it("a candidate that becomes ready is committed, with the old one as the rollback", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 4), { commit: false });
    await store.commitActivation(VERSION(4));
    expect((await restart()).version).toBe(VERSION(4));

    // Its tree breaks: the previous pointer is the rollback.
    fs.rmSync(path.join(store.experiencesDirectory, VERSION(4)), {
      recursive: true,
      force: true,
    });
    expect((await restart()).version).toBe(VERSION(1));
  });

  it("an uncommitted activation over the baseline, abandoned, leaves the baseline", async () => {
    const store = await restart();
    expect(store.version).toBeNull();
    await store.activate(installTree(store, 5), { commit: false });
    await store.abandonActivation(VERSION(5));
    expect(store.version).toBeNull();
    expect((await restart()).version).toBeNull();
  });
});

describe("a second release while an activation is pending", () => {
  it("compares with the committed renderer, so a pending renderer is never committed by the next release", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1, "renderer-A"));
    // v2 brings renderer B, pending readiness.
    await store.activate(installTree(store, 2, "renderer-B"), {
      commit: false,
    });
    expect(store.rendererVersion).toBe("renderer-B");
    expect(store.committedRendererVersion).toBe("renderer-A");

    // v3: renderer B again, a newer agent. It must wait on readiness too.
    expect(rendererChangeNeedsReadiness(store, "renderer-B")).toBe(true);
    // Even one whose renderer is the committed one, while v2 is pending.
    expect(rendererChangeNeedsReadiness(store, "renderer-A")).toBe(true);
    await store.abandonActivation(VERSION(2));
    expect(rendererChangeNeedsReadiness(store, "renderer-A")).toBe(false);
  });

  it("a ready superseded candidate cannot flip before the newer candidate fails", async () => {
    vi.useFakeTimers();
    const store = await restart();
    await store.activate(installTree(store, 1));
    const host = makeHost();
    await host.webContents.loadURL(rendererUrl(VERSION(1)).href);
    const first = host.webContents;
    await store.activate(installTree(store, 2), { commit: false });
    const { scheduler, outcomes, settle } = wire(store, () => host);
    scheduler.schedule(VERSION(2));
    // v2 has loaded and passed readiness, but is still hidden during settle.
    await vi.advanceTimersByTimeAsync(0);
    await store.activate(installTree(store, 3), { commit: false });
    fakes.behaviour.failing = [rendererUrl(VERSION(3)).href];
    scheduler.schedule(VERSION(3));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcomes).toEqual([{ version: VERSION(3), outcome: "gave-up" }]);
    await settle();
    expect(store.version).toBe(VERSION(1));
    expect(host.webContents).toBe(first);
    expect(host.webContents.getURL()).toBe(rendererUrl(VERSION(1)).href);
    expect((await restart()).version).toBe(VERSION(1));
  });

  it("a superseded version's in-flight result is ignored, and the newer one settles on its own swap", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    const pendingSwaps: Array<{ url: URL; fail: (error: Error) => void }> = [];
    const swap = vi.fn(
      (url: URL) =>
        new Promise<boolean>((resolve, reject) => {
          if (url.href === rendererUrl(VERSION(3)).href) resolve(true);
          else pendingSwaps.push({ url, fail: reject });
        })
    );
    const outcomes: Array<[string, string]> = [];
    const scheduler = new RendererSwapScheduler({
      target: (version) =>
        store.version === version ? rendererUrl(version) : null,
      host: () => ({ swap }),
      busy: () => false,
      barrier: SHIPPED_BARRIER,
      pollMs: 1_000,
      log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onOutcome: (version, outcome) => {
        outcomes.push([version, outcome]);
        void (outcome === "gave-up"
          ? store.abandonActivation(version)
          : store.commitActivation(version));
      },
    });

    scheduler.schedule(VERSION(2));
    expect(pendingSwaps).toHaveLength(1);
    // v3 arrives while v2's swap is still in flight.
    await store.activate(installTree(store, 3), { commit: false });
    scheduler.schedule(VERSION(3));
    await vi.waitFor(() => expect(outcomes).toEqual([[VERSION(3), "swapped"]]));
    // v2's late failure neither reschedules v2 nor touches v3.
    pendingSwaps[0]!.fail(new SwapNotReady("timeout"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcomes).toEqual([[VERSION(3), "swapped"]]);
    expect(scheduler.pending).toBe(false);
    expect(swap).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () =>
      expect((await restart()).version).toBe(VERSION(3))
    );
  });
});

describe("activation mutations are serialized", () => {
  it("a newer activation during a commit's writes keeps its rollback state", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    const three = installTree(store, 3);

    // Not awaited in between: the commit's awaits race the activation.
    const committing = store.commitActivation(VERSION(2));
    const activating = store.activate(three, { commit: false });
    await Promise.all([committing, activating]);

    expect(store.version).toBe(VERSION(3));
    expect(store.pendingVersion).toBe(VERSION(3));
    expect((await restart()).version).toBe(VERSION(2));
    // v3 never became ready: back to v2, which was committed.
    await store.abandonActivation(VERSION(3));
    expect(store.version).toBe(VERSION(2));
  });
});

describe("rejections", () => {
  it("expire on a new app version and after the TTL", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    await store.abandonActivation(VERSION(2));
    expect(await store.isRejected(VERSION(2), SHA(2))).toBe(true);

    paths.appVersion = "1.0.1";
    expect(await store.isRejected(VERSION(2), SHA(2))).toBe(false);
    paths.appVersion = "1.0.0";
    expect(await store.isRejected(VERSION(2), SHA(2))).toBe(true);

    vi.useFakeTimers({ now: Date.now() + REJECTION_TTL_MS + 1 });
    expect(await store.isRejected(VERSION(2), SHA(2))).toBe(false);
  });

  it("delete the rejected tree unless a pointer names it", async () => {
    const store = await restart();
    await store.activate(installTree(store, 1));
    await store.activate(installTree(store, 2), { commit: false });
    const rejected = path.join(store.experiencesDirectory, VERSION(2));
    expect(fs.existsSync(rejected)).toBe(true);
    await store.abandonActivation(VERSION(2));
    expect(fs.existsSync(rejected)).toBe(false);
    expect(
      fs.existsSync(path.join(store.experiencesDirectory, VERSION(1)))
    ).toBe(true);
  });
});
