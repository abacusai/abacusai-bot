import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  answer: null as ((stdout: string | null) => void) | null,
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    probe.answer = (stdout) =>
      stdout == null
        ? callback(new Error("no bus"), "")
        : callback(null, stdout);
  },
}));

const trays = vi.hoisted(() => [] as { destroyed: boolean }[]);
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: () => ({}) },
  Tray: class {
    destroyed = false;
    constructor() {
      trays.push(this);
    }
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
  },
}));

const { BackgroundTray } = await import("./background-tray");

const tray = (platform: string) =>
  new BackgroundTray({
    platform,
    icon: () => ({}) as never,
    tooltip: "AbacusAI Bot",
    labels: () => ({ open: "Open", quit: "Quit" }),
    open: () => {},
    quit: () => {},
  });

beforeEach(() => {
  probe.answer = null;
  trays.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("BackgroundTray", () => {
  it.each([
    ["a tray host", "   boolean true", true],
    ["no tray host", "   boolean false", false],
    ["no session bus", null, false],
  ] as const)(
    "on Linux with %s, availability waits for the desktop's answer: %s",
    async (_case, stdout, available) => {
      const subject = tray("linux");
      let answered: boolean | undefined;
      void subject.available().then((value) => {
        answered = value;
      });
      await Promise.resolve();
      expect(answered).toBeUndefined();

      probe.answer!(stdout);
      await vi.waitFor(() => expect(answered).toBe(available));
    }
  );

  it("settles on whether the icon came up after the latest sync", async () => {
    const withHost = tray("linux");
    const shown = withHost.sync(true).then(() => withHost.settled());
    probe.answer!("   boolean true");
    await expect(shown).resolves.toBe(true);

    const noHost = tray("linux");
    const hidden = noHost.sync(true).then(() => noHost.settled());
    probe.answer!("   boolean false");
    await expect(hidden).resolves.toBe(false);
  });

  it("is taken down on quit and stays down", async () => {
    const subject = tray("win32");
    await subject.sync(true);
    expect(subject.shown).toBe(true);

    subject.dispose();
    expect(trays[0]!.destroyed).toBe(true);
    expect(subject.shown).toBe(false);

    await subject.sync(true);
    expect(trays).toHaveLength(1);
    expect(subject.shown).toBe(false);
  });
});
