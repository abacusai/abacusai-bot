/**
 * The Abacus AI bot's install link opens in the app's own window, never
 * through the OS. Handed to the OS, a discord.com link opens the Discord
 * desktop app when one is installed. The app took over the authorize flow
 * and the pairing card waited forever. The window must also refuse the
 * `discord://` handoff the authorize page tries once the bot is added.
 */
import { describe, expect, it, vi } from "vitest";

type Listener = (event: { preventDefault: () => void }, url: string) => void;

const windows: Array<{
  options: Record<string, unknown>;
  loaded: string[];
  listeners: Map<string, Listener>;
  openHandler: ((details: { url: string }) => { action: string }) | null;
  closed: boolean;
}> = [];

vi.mock("electron", () => ({
  BrowserWindow: class {
    options: Record<string, unknown>;
    webContents: {
      on: (name: string, fn: Listener) => void;
      setWindowOpenHandler: (
        fn: (details: { url: string }) => { action: string }
      ) => void;
      setAudioMuted: () => void;
      loadURL: (url: string) => Promise<void>;
    };
    private record: (typeof windows)[number];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      const record = {
        options,
        loaded: [] as string[],
        listeners: new Map<string, Listener>(),
        openHandler: null as
          | ((details: { url: string }) => { action: string })
          | null,
        closed: false,
      };
      this.record = record;
      windows.push(record);
      this.webContents = {
        on: (name, fn) => record.listeners.set(name, fn),
        setWindowOpenHandler: (fn) => {
          record.openHandler = fn;
        },
        setAudioMuted: () => {},
        loadURL: async (url) => {
          record.loaded.push(url);
        },
      };
    }
    on(): void {}
    show(): void {}
    focus(): void {}
    close(): void {
      this.record.closed = true;
    }
    isDestroyed(): boolean {
      return this.record.closed;
    }
    loadURL(url: string): Promise<void> {
      this.record.loaded.push(url);
      return Promise.resolve();
    }
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../bring-to-front", () => ({ parentWindow: () => undefined }));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));
vi.mock("./discord-web-connector", () => ({
  DISCORD_PARTITION: "persist:discord-web",
}));

const { AbacusChannelsConnector, isWebUrl, keepOnTheWeb } =
  await import("./abacus-channels-connector");
const { shell } = await import("electron");

const INSTALL = "https://discord.com/oauth2/authorize?client_id=1&scope=bot";

const pendingConnector = (): InstanceType<typeof AbacusChannelsConnector> => {
  const connector = new AbacusChannelsConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: () => {},
  });
  (connector as unknown as { link: unknown }).link = {
    status: "pending",
    deepLink: INSTALL,
    code: "abc",
  };
  return connector;
};

describe("opening the install link", () => {
  it("loads it in the app's own window on the Discord web session", () => {
    windows.length = 0;
    pendingConnector().openLink();

    expect(windows).toHaveLength(1);
    expect(windows[0]!.loaded).toEqual([INSTALL]);
    expect(
      (windows[0]!.options.webPreferences as { partition: string }).partition
    ).toBe("persist:discord-web");
    // Wide enough for Discord's app-profile card, which clipped at 520.
    expect(windows[0]!.options).toMatchObject({ width: 1000, height: 720 });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("refuses to open when there is no link yet", () => {
    const connector = new AbacusChannelsConnector({
      onMessage: () => {},
      onState: () => {},
      onLog: () => {},
    });
    expect(() => connector.openLink()).toThrow(/Press Link first/);
  });

  it("closes the window once the link lands", () => {
    windows.length = 0;
    const connector = pendingConnector();
    connector.openLink();
    (
      connector as unknown as { markLinked: (n: string | null) => void }
    ).markLinked("Sd");
    expect(windows[0]!.closed).toBe(true);
  });
});

describe("keeping the window on the web", () => {
  const prevented = (
    name: "will-navigate" | "will-redirect",
    url: string
  ): boolean => {
    windows.length = 0;
    pendingConnector().openLink();
    let stopped = false;
    windows[0]!.listeners.get(name)!(
      { preventDefault: () => (stopped = true) },
      url
    );
    return stopped;
  };

  it("cancels the desktop app handoff", () => {
    expect(prevented("will-navigate", "discord://-/oauth2/authorized")).toBe(
      true
    );
    expect(prevented("will-redirect", "discord://-/oauth2/authorized")).toBe(
      true
    );
  });

  it("lets the web flow navigate", () => {
    expect(prevented("will-navigate", "https://discord.com/login")).toBe(false);
    expect(
      prevented("will-redirect", "https://discord.com/oauth2/authorized")
    ).toBe(false);
  });

  it("turns popups into in-window loads, never an OS call", () => {
    windows.length = 0;
    pendingConnector().openLink();
    const record = windows[0]!;
    expect(record.openHandler!({ url: "https://discord.com/x" })).toEqual({
      action: "deny",
    });
    expect(record.loaded).toContain("https://discord.com/x");
    expect(record.openHandler!({ url: "discord://x" })).toEqual({
      action: "deny",
    });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("is exported for any other window that needs the same rule", () => {
    expect(typeof keepOnTheWeb).toBe("function");
    expect(isWebUrl("https://a.b")).toBe(true);
    expect(isWebUrl("discord://a")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
  });
});
