/**
 * Spec 07 review r1 #9: an experience whose renderer never passes the swap's
 * readiness barrier is never persisted as active. The swap scheduler's
 * `gave-up` rolls this process back and remembers the candidate as rejected;
 * a full restart (a new store reading the pointers) boots the committed
 * experience, and a crash before readiness does too. A candidate that
 * becomes ready is committed with the old one as `previous`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => paths.userData,
    getVersion: () => "1.0.0",
    getAppPath: () => paths.userData,
    isPackaged: false,
  },
}));

// The tree check is integrity.test.ts's; here a directory with a
// `manifest.json` is an intact experience of that version.
vi.mock("./integrity", () => ({
  verifyExperience: async (directory: string) =>
    JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")),
}));

const { ExperienceStore } = await import("./experience-store");
const { RendererSwapScheduler, SwapNotReady } =
  await import("../../../renderer-host");

const VERSION = (n: number) => String(n).repeat(64).slice(0, 64);
const SHA = (n: number) => `${"f".repeat(63)}${n}`;

beforeEach(() => {
  paths.userData = fs.mkdtempSync(path.join(os.tmpdir(), "experience-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(paths.userData, { recursive: true, force: true });
});

/** An installed tree for version `n` with its own renderer. */
const installTree = (
  store: InstanceType<typeof ExperienceStore>,
  n: number
) => {
  const manifest = {
    experienceVersion: VERSION(n),
    rendererVersion: `renderer-${n}`,
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

describe("experience activation is transactional with renderer readiness", () => {
  it("a candidate that never becomes ready is rolled back and rejected, and a restart boots the previous one", async () => {
    vi.useFakeTimers();
    const store = await restart();
    await store.activate(installTree(store, 1));
    expect(store.version).toBe(VERSION(1));

    // A new renderer: live in this process, not persisted yet.
    await store.activate(installTree(store, 2), { commit: false });
    expect(store.version).toBe(VERSION(2));
    expect((await restart()).version).toBe(VERSION(1));

    // The swap fails its readiness barrier until the budget is spent.
    const swap = vi.fn(async () => {
      throw new SwapNotReady("timeout");
    });
    const outcomes: string[] = [];
    const scheduler = new RendererSwapScheduler({
      target: () => new URL(`app://${store.version}/index.html`),
      host: () => ({ swap }),
      busy: () => false,
      barrier: "subscriptions",
      pollMs: 10,
      log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onOutcome: (version, outcome) => {
        outcomes.push(outcome);
        if (outcome === "gave-up") void store.abandonActivation(version);
        else void store.commitActivation(version);
      },
    });
    scheduler.schedule(VERSION(2));
    await vi.advanceTimersByTimeAsync(200);
    scheduler.cancel();
    vi.useRealTimers();
    await vi.waitFor(() => expect(outcomes).toEqual(["gave-up"]));
    await vi.waitFor(() => expect(store.version).toBe(VERSION(1)));

    // A full restart: the rejected candidate does not boot, and stays rejected.
    const relaunched = await restart();
    expect(relaunched.version).toBe(VERSION(1));
    expect(await relaunched.isRejected(VERSION(2), SHA(2))).toBe(true);
    expect(await relaunched.isRejected(VERSION(1), SHA(1))).toBe(false);
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
