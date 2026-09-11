import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeWebContents {
    static loadFailures = new Map<string, Error>();
    /** When false, the fake renderer never signals renderer-ready. */
    static signalsReady = true;
    readonly close = vi.fn(() => {
      this.destroyed = true;
    });
    readonly executeJavaScript = vi.fn(async (script: string) =>
      script.includes("__captureUiContinuity")
        ? { focus: { selector: "#composer" }, scrolls: [] }
        : undefined
    );
    readonly focus = vi.fn();
    readonly send = vi.fn();
    destroyed = false;
    focused = false;
    private readonly listeners = new Map<
      string,
      ((...args: unknown[]) => void)[]
    >();
    private url = "";

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    getURL(): string {
      return this.url;
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isFocused(): boolean {
      return this.focused;
    }

    async loadURL(url: string): Promise<void> {
      const failure = FakeWebContents.loadFailures.get(url);

      if (failure !== undefined) throw failure;

      this.url = url;

      if (FakeWebContents.signalsReady) {
        queueMicrotask(() => this.emit("ipc-message", {}, "renderer-ready"));
      }
    }

    off(event: string, listener: (...args: unknown[]) => void): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== listener)
      );
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
    }
  }

  class FakeWebContentsView {
    bounds = { height: 0, width: 0, x: 0, y: 0 };
    readonly webContents = new FakeWebContents();

    getBounds(): { height: number; width: number; x: number; y: number } {
      return this.bounds;
    }

    setBackgroundColor(): void {}

    setBounds(bounds: {
      height: number;
      width: number;
      x: number;
      y: number;
    }): void {
      this.bounds = bounds;
    }
  }

  class FakeWindow {
    readonly children: FakeWebContentsView[] = [];
    readonly contentView = {
      addChildView: (view: FakeWebContentsView, index?: number) => {
        const at = index ?? this.children.length;

        this.children.splice(at, 0, view);
      },
      children: this.children,
      removeChildView: (view: FakeWebContentsView) => {
        const at = this.children.indexOf(view);

        if (at !== -1) this.children.splice(at, 1);
      },
    };
    destroyed = false;
    readonly listeners = new Map<string, (() => void)[]>();

    getContentBounds(): {
      height: number;
      width: number;
      x: number;
      y: number;
    } {
      return { height: 600, width: 800, x: 10, y: 20 };
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    on(event: string, listener: () => void): void {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
    }
  }

  return { FakeWebContents, FakeWebContentsView, FakeWindow };
});

vi.mock("electron", () => ({ WebContentsView: mocks.FakeWebContentsView }));

import {
  RendererHost,
  rendererWebContents,
  sendToRenderer,
  setActiveRendererHost,
} from "./renderer-host";
import type { RendererHostOptions } from "./renderer-host";

type FakeWindow = InstanceType<typeof mocks.FakeWindow>;

const makeHost = (
  window: FakeWindow = new mocks.FakeWindow(),
  wire: RendererHostOptions["wire"] = () => undefined
): { host: RendererHost; window: FakeWindow } => ({
  host: new RendererHost({
    backgroundColor: "#000000",
    webPreferences: {},
    window: window as never,
    wire,
  }),
  window,
});

const contentsOf = (
  host: RendererHost
): InstanceType<typeof mocks.FakeWebContents> =>
  host.webContents as unknown as InstanceType<typeof mocks.FakeWebContents>;

beforeEach(() => {
  mocks.FakeWebContents.loadFailures.clear();
  mocks.FakeWebContents.signalsReady = true;
  setActiveRendererHost(null);
});

describe("RendererHost", () => {
  it("attaches the initial view sized to the window content", () => {
    const { window } = makeHost();

    expect(window.children).toHaveLength(1);
    expect(window.children[0].bounds).toEqual({
      height: 600,
      width: 800,
      x: 0,
      y: 0,
    });
  });

  it("wires every webContents it creates", async () => {
    const wired: unknown[] = [];
    const { host } = makeHost(new mocks.FakeWindow(), (contents) => {
      wired.push(contents);
    });

    await host.swap(new URL("app://bundle.new/"));

    expect(wired).toHaveLength(2);
    expect(wired[1]).toBe(host.webContents);
  });

  it("swaps to the new document at the current route", async () => {
    const { host, window } = makeHost();
    const first = contentsOf(host);

    await first.loadURL("app://bundle.old/#/settings/models");
    await host.swap(new URL("app://bundle.new/"));

    expect(host.webContents).not.toBe(first);
    expect(host.webContents.getURL()).toBe(
      "app://bundle.new/#/settings/models"
    );
    expect(window.children).toHaveLength(1);
    expect(first.close).toHaveBeenCalled();
  });

  it("keeps the old renderer when the new one fails to load", async () => {
    const { host, window } = makeHost();
    const first = contentsOf(host);
    const initialView = window.children[0];

    await first.loadURL("app://bundle.old/#/workspace");
    mocks.FakeWebContents.loadFailures.set(
      "app://bundle.new/#/workspace",
      new Error("did-fail-load")
    );

    await expect(host.swap(new URL("app://bundle.new/"))).rejects.toThrow(
      "did-fail-load"
    );
    expect(host.webContents).toBe(first);
    expect(window.children).toEqual([initialView]);
    expect(first.close).not.toHaveBeenCalled();
  });

  it("refocuses the new renderer when the old one had focus", async () => {
    const { host } = makeHost();

    contentsOf(host).focused = true;
    await host.swap(new URL("app://bundle.new/"));

    expect(contentsOf(host).focus).toHaveBeenCalled();
  });

  it("stands down when the caller says the user came back", async () => {
    const { host, window } = makeHost();
    const first = contentsOf(host);
    const initialView = window.children[0];

    await expect(
      host.swap(new URL("app://bundle.new/"), { shouldAbort: () => true })
    ).rejects.toThrow("stood down");
    expect(host.webContents).toBe(first);
    expect(window.children).toEqual([initialView]);
    expect(first.close).not.toHaveBeenCalled();
  });

  it("carries focus and scroll from the old renderer to the new", async () => {
    const { host } = makeHost();
    const first = contentsOf(host);

    await host.swap(new URL("app://bundle.new/"));

    expect(first.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("__captureUiContinuity")
    );
    expect(contentsOf(host).executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('__restoreUiContinuity?.({"focus"')
    );
  });

  it("resizes the live view when the window resizes", async () => {
    const { host, window } = makeHost();

    await host.swap(new URL("app://bundle.new/"));
    window.children[0].bounds = { height: 1, width: 1, x: 0, y: 0 };
    for (const listener of window.listeners.get("resize") ?? []) listener();

    expect(window.children[0].bounds).toEqual({
      height: 600,
      width: 800,
      x: 0,
      y: 0,
    });
  });
});

describe("sendToRenderer", () => {
  it("does nothing without an active host", () => {
    expect(rendererWebContents()).toBeNull();
    sendToRenderer("channel", { some: "payload" });
  });

  it("reaches the active host's live renderer, across swaps", async () => {
    const { host } = makeHost();

    setActiveRendererHost(host);
    await host.swap(new URL("app://bundle.new/"));
    sendToRenderer("channel", "payload");

    expect(rendererWebContents()).toBe(host.webContents);
    expect(contentsOf(host).send).toHaveBeenCalledWith("channel", "payload");
  });
});
