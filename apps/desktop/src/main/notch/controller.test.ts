import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PrefsRow } from "../../shared/contract/rows";
const DEFAULT_PREFS = {
  notch: { enabled: true, haptics: false, extraDisplays: false },
} as PrefsRow;
import type { NotchShape } from "../../shared/contract/notch";
import { NotchController, type NotchControllerOptions } from "./controller";

const f = vi.hoisted(() => ({
  windows: [] as any[],
  views: [] as any[],
  shortcut: null as (() => void) | null,
  space: null as (() => void) | null,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const display = {
    id: 1,
    internal: true,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    workArea: { x: 0, y: 0, width: 1280, height: 752 },
  };
  return {
    screen: Object.assign(new EventEmitter(), {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    }),
    powerMonitor: new EventEmitter(),
    globalShortcut: {
      register: vi.fn((_key, fn) => {
        f.shortcut = fn;
        return true;
      }),
      unregister: vi.fn(),
    },
    systemPreferences: {
      subscribeWorkspaceNotification: vi.fn((_name, fn) => {
        f.space = fn;
        return 1;
      }),
      unsubscribeWorkspaceNotification: vi.fn(),
    },
  };
});
vi.mock("./metrics", async (original) => ({
  ...(await original<typeof import("./metrics")>()),
  probeNotchMetrics: async () => ({
    kind: "ok",
    screens: [
      {
        frame: { x: 0, y: 0, width: 1280, height: 800 },
        top: 32,
        left: 540,
        right: 540,
      },
    ],
  }),
}));
vi.mock("./window", async () => {
  const { EventEmitter } = await import("node:events");
  const createNotchView = () => {
    const contents = Object.assign(new EventEmitter(), {
      id: f.views.length + 1,
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      close: vi.fn(function (this: any) {
        this.destroyed = true;
      }),
      loadFile: async () => undefined,
      loadURL: async () => undefined,
    });
    const view = {
      webContents: contents,
      visible: true,
      setVisible: vi.fn(function (this: any, value: boolean) {
        this.visible = value;
      }),
      setBounds: vi.fn(),
    };
    f.views.push(view);
    return view;
  };
  return {
    createNotchView,
    fitView: (win: any, view: any) => view.setBounds(win.bounds),
    createNotchWindow: (_platform: string, placement: any) => {
      const win = Object.assign(new EventEmitter(), {
        bounds: placement.bounds,
        destroyed: false,
        visible: false,
        isDestroyed() {
          return this.destroyed;
        },
        isVisible() {
          return this.visible;
        },
        isFocused: () => false,
        setBounds(value: any) {
          this.bounds = value;
        },
        showInactive() {
          this.visible = true;
        },
        hide(this: any) {
          this.visible = false;
          this.emit("hide");
        },
        destroy: vi.fn(function (this: any) {
          this.destroyed = true;
          this.emit("closed");
        }),
        contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
        setIgnoreMouseEvents: vi.fn(),
        setFocusable: vi.fn(),
        focus: vi.fn(),
        blur: vi.fn(),
      });
      const view = createNotchView();
      f.windows.push(win);
      return { win, view };
    },
  };
});
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
const controllers: NotchController[] = [];
const setup = async (overrides: Partial<NotchControllerOptions> = {}) => {
  let prefs = {
    ...DEFAULT_PREFS,
    notch: { ...DEFAULT_PREFS.notch, enabled: true },
  };
  let base = { kind: "file" as const, directory: "/old" };
  const waiters = new Map<number, (result: "ready" | "timeout") => void>();
  const options = {
    platform: "win32",
    generation: "wco",
    packaged: false,
    preload: "/preload",
    prefs: () => prefs,
    base: () => base,
    readiness: {
      wait: (id: number) => new Promise((resolve) => waiters.set(id, resolve)),
      discard: vi.fn(),
    },
    wire: vi.fn(),
    unregister: vi.fn(),
    revealMain: vi.fn(),
    mainState: () => ({ visible: true, focused: false }),
    publish: vi.fn(),
    command: vi.fn(),
    ...overrides,
  } as unknown as NotchControllerOptions;
  const controller = new NotchController(options);
  controllers.push(controller);
  controller.start();
  await controller.reconcile();
  await flush();
  return {
    controller,
    options,
    ready: async (id: number, result: "ready" | "timeout" = "ready") => {
      waiters.get(id)?.(result);
      await flush();
    },
    disable: () => {
      prefs = { ...prefs, notch: { ...prefs.notch, enabled: false } };
    },
    swap: () => {
      base = { kind: "file", directory: "/new" };
    },
  };
};
const shape: NotchShape = {
  phase: "final",
  width: 400,
  height: 180,
  visible: true,
  audio: true,
};
beforeEach(() => {
  f.windows.length = 0;
  f.views.length = 0;
  f.shortcut = null;
  f.space = null;
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});
describe("R6-T25/T28 controller lifecycle and ownership", () => {
  it.each([{ generation: "legacy" }, { platform: "linux" }])(
    "creates nothing for %j",
    async (override) => {
      const { controller } = await setup(override);
      expect(f.windows).toHaveLength(0);
      expect(controller.status().available).toBe(false);
    }
  );
  it("waits for readiness, fits changes and closes every contents once", async () => {
    const x = await setup();
    x.controller.setShape(1, shape);
    expect(f.windows[0].visible).toBe(false);
    await x.ready(1);
    x.controller.visibility(1, true);
    expect(x.controller.canPlay(1)).toBe(true);
    expect(f.views[0].setBounds).toHaveBeenLastCalledWith(f.windows[0].bounds);
    x.disable();
    await x.controller.reconcile();
    expect(f.views[0].webContents.close).toHaveBeenCalledOnce();
    x.controller.dispose();
    expect(f.views[0].webContents.close).toHaveBeenCalledOnce();
  });
  it("boots a hidden standby; native reports cannot steal the live window", async () => {
    const x = await setup();
    await x.ready(1);
    x.controller.setShape(1, shape);
    x.controller.visibility(1, true);
    x.swap();
    await x.controller.reconcile();
    await flush();
    expect(f.views[1].visible).toBe(false);
    x.controller.setShape(2, { ...shape, width: 500 });
    expect(f.windows[0].bounds.width).toBe(448);
    expect(() => x.controller.visibility(2, true)).toThrow();
    expect(() => x.controller.focus(2, true)).toThrow();
    expect(x.controller.canPlay(2)).toBe(false);
    await x.ready(2);
    expect(f.views[0].webContents.close).toHaveBeenCalledOnce();
    expect(f.views[1].visible).toBe(true);
    expect(f.windows[0].bounds.width).toBe(548);
    expect(x.controller.seen(2)).toBe(false);
    x.controller.visibility(2, true);
    expect(x.controller.canPlay(2)).toBe(true);
  });
  it("keeps the old view when replacement readiness fails", async () => {
    const x = await setup();
    await x.ready(1);
    x.swap();
    await x.controller.reconcile();
    await flush();
    await x.ready(2, "timeout");
    expect(f.views[1].webContents.close).toHaveBeenCalledOnce();
    expect(f.views[0].webContents.close).not.toHaveBeenCalled();
    expect(x.controller.owns(1)).toBe(true);
  });
  it("clears visibility and audio eligibility on navigation", async () => {
    const x = await setup();
    await x.ready(1);
    x.controller.setShape(1, shape);
    x.controller.visibility(1, true);
    f.views[0].webContents.emit("did-start-navigation", {}, "", false, true);
    expect(x.controller.seen(1)).toBe(false);
    expect(x.controller.canPlay(1)).toBe(false);
    x.controller.documentReady(1);
    expect(x.controller.seen(1)).toBe(false);
  });
  it("retains command ids until ack and newer acknowledgments clear superseded targets", async () => {
    vi.useFakeTimers();
    const x = await setup();
    const a = x.controller.open(1, { kind: "session", sessionId: "a" });
    vi.advanceTimersByTime(1);
    const b = x.controller.open(1, { kind: "session", sessionId: "b" });
    expect(x.controller.commands().map((c) => c.id)).toEqual([a.id, b.id]);
    x.controller.ack(b.id);
    expect(x.controller.commands()).toEqual([]);
    expect(x.options.command).toHaveBeenCalledTimes(2);
  });
  it("invalidates seen state on macOS active-Space notification", async () => {
    const x = await setup({ platform: "darwin" });
    await x.ready(1);
    x.controller.setShape(1, shape);
    x.controller.visibility(1, true);
    expect(x.controller.seen(1)).toBe(true);
    f.space?.();
    expect(x.controller.seen(1)).toBe(false);
  });
});
