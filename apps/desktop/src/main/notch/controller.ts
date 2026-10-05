import type { EventEmitter } from "node:events";

import type {
  NotchEvent,
  NotchLayout,
  NotchShape,
  NotchStatus,
  OpenCommand,
  OpenTarget,
  PrefsRow,
  WindowState,
} from "@abacus-ai/contract/contract";
import {
  globalShortcut,
  powerMonitor,
  screen,
  systemPreferences,
  type Display,
  type WebContents,
  type WebContentsView,
} from "electron";

import { notchEntry, type RendererBase } from "../renderer-entry";
import { forbidden } from "../rpc/errors";
import type { RendererReadiness } from "../rpc/readiness";
import { disposeNotchWindow, disposeView } from "./dispose";
import { capsulePlacement, notchPlacement, type Placement } from "./geometry";
import { Haptics } from "./haptics";
import { setFocused, setInteractive } from "./interaction";
import {
  devMetrics,
  matchScreens,
  metricsCacheKey,
  probeNotchMetrics,
} from "./metrics";
import { createNotchView, createNotchWindow, fitView } from "./window";
interface Entry {
  win: Electron.BaseWindow;
  active: WebContentsView;
  standby: WebContentsView | null;
  disposed: boolean;
  ready: boolean;
  documentVisible: boolean;
  audio: boolean;
  placement: Placement;
  shape: NotchShape;
  staged: NotchShape | null;
  base: RendererBase;
}
export interface NotchControllerOptions {
  platform: string;
  packaged: boolean;
  preload: string;
  prefs(): PrefsRow;
  base(): RendererBase | null;
  readiness: RendererReadiness;
  wire(contents: WebContents): void;
  unregister(id: number): void;
  revealMain(): void;
  mainState(): { visible: boolean; focused: boolean };
  publish(id: number, event: NotchEvent): void;
  command(command: OpenCommand): void;
}
const SHORTCUT = "CommandOrControl+Shift+Space";
export class NotchController {
  readonly #o: NotchControllerOptions;
  readonly #entries = new Map<number, Entry>();
  readonly #metrics = new Map<string, NotchLayout["notch"]>();
  readonly #haptics = new Haptics();
  readonly #pending = new Map<string, OpenCommand>();
  readonly #presentations = new Map<string, number>();
  readonly #failures: number[] = [];
  readonly #stops: (() => void)[] = [];
  #chain: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #space: number | null = null;
  #spaceEpoch = 0;
  #started = false;
  #disposed = false;
  #metricsFailed = false;
  #reconciled = false;
  #shortcut: NotchStatus["shortcut"] = "off";
  #lastDisplay: number | null = null;
  constructor(options: NotchControllerOptions) {
    this.#o = options;
  }
  start(): void {
    if (
      this.#started ||
      this.#disposed ||
      false ||
      !["darwin", "win32"].includes(this.#o.platform)
    )
      return;
    this.#started = true;
    for (const event of [
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ] as const) {
      const run = () => {
        this.#metrics.clear();
        this.schedule();
      };
      (screen as unknown as EventEmitter).on(event, run);
      this.#stops.push(() =>
        (screen as unknown as EventEmitter).removeListener(event, run)
      );
    }
    for (const event of ["resume", "unlock-screen"] as const) {
      const run = () => this.schedule();
      (powerMonitor as unknown as EventEmitter).on(event, run);
      this.#stops.push(() =>
        (powerMonitor as unknown as EventEmitter).removeListener(event, run)
      );
    }
    if (this.#o.platform === "darwin")
      this.#space = systemPreferences.subscribeWorkspaceNotification(
        "NSWorkspaceActiveSpaceDidChangeNotification",
        () => {
          ++this.#spaceEpoch;
          for (const entry of this.#entries.values()) {
            entry.documentVisible = false;
            this.#o.publish(entry.active.webContents.id, {
              type: "visibility-request",
              epoch: this.#spaceEpoch,
            });
          }
        }
      );
    void this.reconcile();
  }
  schedule(): void {
    if (this.#disposed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.reconcile();
    }, 250);
  }
  reconcile(): Promise<void> {
    this.#chain = this.#chain
      .then(async () => {
        await this.#reconcile();
        this.#reconciled = true;
      })
      .catch((error) => console.warn("[notch] reconcile failed", error));
    return this.#chain;
  }
  async #reconcile(): Promise<void> {
    if (!this.#started || this.#disposed) return;
    if (!this.#o.prefs().notch?.enabled) {
      this.#clear();
      this.#failures.length = 0;
      this.#metrics.clear();
      return;
    }
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    if (
      this.#o.platform === "darwin" &&
      displays.some((d) => !this.#metrics.has(metricsCacheKey(d)))
    ) {
      const result = await probeNotchMetrics();
      if (this.#disposed || !this.#o.prefs().notch?.enabled) return;
      this.#metricsFailed = result.kind !== "ok";
      if (result.kind === "ok") {
        const matched = matchScreens(
          result.screens,
          displays,
          primary.bounds.height
        );
        for (const d of displays)
          if (matched.has(d.id))
            this.#metrics.set(metricsCacheKey(d), matched.get(d.id)!);
      }
      const override = devMetrics(
        process.env.ABACUSBOT_NOTCH_METRICS,
        this.#o.packaged
      );
      if (override) {
        this.#metrics.set(metricsCacheKey(primary), override);
        this.#metricsFailed = false;
      }
    }
    const target =
      this.#o.platform === "win32"
        ? [primary]
        : this.#o.prefs().notch?.extraDisplays
          ? displays
          : [
              displays.find(
                (d) => d.internal && this.#metrics.get(metricsCacheKey(d))
              ) ?? primary,
            ];
    const eligible = target.filter(
      (d) =>
        this.#o.platform === "win32" ||
        !d.internal ||
        this.#metrics.has(metricsCacheKey(d))
    );
    if (eligible.length < target.length) this.#metricsFailed = true;
    for (const [id, e] of this.#entries)
      if (!eligible.some((d) => d.id === id)) this.#remove(id, e);
    const base = this.#o.base();
    if (!base) return;
    if (this.#failures.filter((at) => Date.now() - at < 600_000).length >= 3)
      return;
    for (const d of eligible) {
      const e = this.#entries.get(d.id);
      try {
        if (!e) this.#create(d, base);
        else {
          this.#apply(e, e.shape);
          if (JSON.stringify(e.base) !== JSON.stringify(base) && !e.standby)
            this.#swap(e, base);
        }
      } catch (error) {
        console.warn("[notch] window creation failed", error);
        this.#failed();
      }
    }
    if (this.#shortcut === "off")
      this.#shortcut = globalShortcut.register(SHORTCUT, () =>
        this.#onShortcut()
      )
        ? "registered"
        : "unavailable";
    this.appChanged();
  }
  #place(d: Display, shape: NotchShape): Placement {
    return this.#o.platform === "win32"
      ? capsulePlacement(d, shape)
      : notchPlacement(d, this.#metrics.get(metricsCacheKey(d)) ?? null, shape);
  }
  #create(d: Display, base: RendererBase): void {
    const shape: NotchShape = {
      phase: "final",
      width: 296,
      height: 32,
      visible: false,
      audio: false,
    };
    const placement = this.#place(d, shape);
    const { win, view } = createNotchWindow(
      this.#o.platform,
      placement,
      this.#o.preload
    );
    const e: Entry = {
      win,
      active: view,
      standby: null,
      disposed: false,
      ready: false,
      documentVisible: false,
      audio: false,
      placement,
      shape,
      staged: null,
      base,
    };
    this.#entries.set(d.id, e);
    win.on("blur", () => {
      if (!e.disposed) setInteractive(win, false);
    });
    win.on("hide", () => {
      e.documentVisible = false;
    });
    win.on("closed", () => {
      if (!e.disposed) this.#remove(d.id, e);
    });
    try {
      this.#boot(e, view, base, false);
    } catch (error) {
      this.#remove(d.id, e);
      throw error;
    }
  }
  #boot(
    e: Entry,
    view: WebContentsView,
    base: RendererBase,
    standby: boolean
  ): void {
    this.#o.wire(view.webContents);
    view.webContents.on(
      "did-start-navigation",
      (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame && e.active === view) {
          e.documentVisible = false;
          e.audio = false;
          e.ready = false;
        }
      }
    );
    view.webContents.on("render-process-gone", () => {
      if (e.disposed) return;
      if (e.standby === view) {
        e.standby = null;
        disposeView(e.win, view, (id) => this.#forget(id));
      } else this.#remove(e.placement.layout.displayId, e);
      this.#failed();
    });
    const entry = notchEntry(base);
    const loaded = Promise.resolve().then(() =>
      entry.kind === "file"
        ? view.webContents.loadFile(entry.path)
        : view.webContents.loadURL(entry.url)
    );
    void loaded
      .then(() => this.#o.readiness.wait(view.webContents.id, 10_000))
      .then((outcome) => {
        if (
          e.disposed ||
          view.webContents.isDestroyed() ||
          (standby && e.standby !== view)
        )
          return;
        if (outcome !== "ready") {
          if (standby) {
            e.standby = null;
            disposeView(e.win, view, (id) => this.#forget(id));
          } else this.#remove(e.placement.layout.displayId, e);
          this.#failed();
          return;
        }
        if (standby) {
          if (JSON.stringify(base) !== JSON.stringify(this.#o.base())) {
            e.standby = null;
            e.staged = null;
            disposeView(e.win, view, (id) => this.#forget(id));
            void this.reconcile();
            return;
          }
          const old = e.active;
          e.active = view;
          e.standby = null;
          e.documentVisible = false;
          e.audio = false;
          e.base = base;
          e.ready = true;
          if (e.staged) this.#apply(e, e.staged);
          e.staged = null;
          view.setVisible(true);
          disposeView(e.win, old, (id) => this.#forget(id));
          void this.reconcile();
        } else {
          e.ready = true;
          this.#apply(e, e.shape);
        }
      })
      .catch((error) => {
        console.warn("[notch] boot failed", error);
        if (
          e.disposed ||
          view.webContents.isDestroyed() ||
          (standby && e.standby !== view)
        )
          return;
        if (standby) {
          e.standby = null;
          disposeView(e.win, view, (id) => this.#forget(id));
        } else this.#remove(e.placement.layout.displayId, e);
        this.#failed();
      });
  }
  #swap(e: Entry, base: RendererBase): void {
    const view = createNotchView(this.#o.preload);
    e.standby = view;
    view.setVisible(false);
    e.win.contentView.addChildView(view);
    fitView(e.win, view);
    try {
      this.#boot(e, view, base, true);
    } catch (error) {
      e.standby = null;
      disposeView(e.win, view, (id) => this.#forget(id));
      throw error;
    }
  }
  #failed(): void {
    this.#failures.push(Date.now());
    if (
      this.#disposed ||
      this.#failures.filter((at) => Date.now() - at < 600_000).length >= 3
    )
      return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = null;
        void this.reconcile();
      },
      [2000, 10_000, 60_000][Math.min(this.#failures.length - 1, 2)]
    );
  }
  #forget(id: number): void {
    this.#o.readiness.discard(id);
    this.#o.unregister(id);
  }
  #remove(id: number, e: Entry): void {
    this.#entries.delete(id);
    disposeNotchWindow(e, (id) => this.#forget(id));
  }
  #clear(): void {
    for (const [id, e] of this.#entries) this.#remove(id, e);
    globalShortcut.unregister(SHORTCUT);
    this.#shortcut = "off";
  }
  #entry(id: number, active = true): Entry {
    const e = [...this.#entries.values()].find(
      (e) => e.active.webContents.id === id || e.standby?.webContents.id === id
    );
    if (!e || e.disposed) throw forbidden("not-notch");
    if (active && e.active.webContents.id !== id) throw forbidden("standby");
    return e;
  }
  owns(id: number): boolean {
    return [...this.#entries.values()].some(
      (e) => e.active.webContents.id === id || e.standby?.webContents.id === id
    );
  }
  documentReady(id: number): void {
    const entry = [...this.#entries.values()].find(
      (entry) => entry.active.webContents.id === id
    );
    if (!entry || entry.disposed) return;
    entry.ready = true;
    this.#apply(entry, entry.shape);
  }
  requireActive(id: number): void {
    this.#entry(id);
  }
  state(id: number): WindowState | null {
    if (!this.owns(id)) return null;
    const e = this.#entry(id, false);
    return { focused: e.win.isFocused(), fullScreen: false, maximized: false };
  }
  layout(id: number): NotchLayout {
    return this.#entry(id, false).placement.layout;
  }
  initial(id: number): NotchEvent[] {
    const app = this.#o.mainState();
    return [
      { type: "layout", layout: this.layout(id) },
      { type: "app", mainVisible: app.visible, mainFocused: app.focused },
      { type: "visibility-request", epoch: this.#spaceEpoch },
    ];
  }
  #apply(e: Entry, shape: NotchShape): void {
    const d = screen
      .getAllDisplays()
      .find((d) => d.id === e.placement.layout.displayId);
    if (!d || e.disposed) return;
    e.shape = shape;
    e.audio = shape.audio;
    e.placement = this.#place(d, shape);
    e.win.setBounds(e.placement.bounds);
    fitView(e.win, e.active);
    if (e.standby) fitView(e.win, e.standby);
    if (e.ready && shape.visible) e.win.showInactive();
    else e.win.hide();
    this.#o.publish(e.active.webContents.id, {
      type: "layout",
      layout: e.placement.layout,
    });
  }
  setShape(id: number, shape: NotchShape): NotchLayout {
    const e = this.#entry(id, false);
    if (e.active.webContents.id !== id) e.staged = shape;
    else this.#apply(e, shape);
    return e.placement.layout;
  }
  visibility(id: number, visible: boolean, epoch = 0): void {
    const entry = this.#entry(id);
    if (epoch === this.#spaceEpoch) entry.documentVisible = visible;
  }
  interactive(id: number, interactive: boolean): void {
    const e = this.#entry(id);
    this.#lastDisplay = e.placement.layout.displayId;
    setInteractive(e.win, interactive);
  }
  focus(id: number, focus: boolean): void {
    setFocused(this.#entry(id).win, focus);
  }
  haptic(id: number, key: string): void {
    this.#entry(id);
    this.#haptics.play(
      key,
      this.#o.prefs().notch?.haptics === true,
      this.#o.platform
    );
  }
  seen(id: number): boolean {
    const e = [...this.#entries.values()].find(
      (e) => e.active.webContents.id === id
    );
    return !!e && e.ready && e.documentVisible && e.win.isVisible();
  }
  canPlay(id: number): boolean {
    const e = [...this.#entries.values()].find(
      (e) => e.active.webContents.id === id
    );
    return !!e && e.audio && this.seen(id);
  }
  audible(): number | null {
    const entries = [...this.#entries.values()].filter((e) =>
      this.canPlay(e.active.webContents.id)
    );
    const nearest = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint()
    ).id;
    return (
      (
        entries.find((e) => e.placement.layout.displayId === nearest) ??
        entries.find(
          (e) => e.placement.layout.displayId === screen.getPrimaryDisplay().id
        )
      )?.active.webContents.id ?? null
    );
  }
  #onShortcut(): void {
    const entries = [...this.#entries.values()].filter((e) =>
      this.seen(e.active.webContents.id)
    );
    const nearest = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint()
    ).id;
    const e =
      entries.find((e) => e.placement.layout.displayId === nearest) ??
      entries.find((e) => e.placement.layout.displayId === this.#lastDisplay) ??
      entries.find(
        (e) => e.placement.layout.displayId === screen.getPrimaryDisplay().id
      );
    if (!e) {
      this.#o.revealMain();
      return;
    }
    setFocused(e.win, true);
    this.#o.publish(e.active.webContents.id, { type: "shortcut" });
  }
  appChanged(): void {
    const app = this.#o.mainState();
    this.broadcast({
      type: "app",
      mainVisible: app.visible,
      mainFocused: app.focused,
    });
  }
  broadcast(event: NotchEvent): void {
    for (const e of this.#entries.values()) {
      this.#o.publish(e.active.webContents.id, event);
      if (e.standby) this.#o.publish(e.standby.webContents.id, event);
    }
  }
  preview(): void {
    this.broadcast({ type: "preview" });
  }
  commands(): OpenCommand[] {
    for (const [id, c] of this.#pending)
      if (Date.now() - c.at > 600_000) this.#pending.delete(id);
    return [...this.#pending.values()];
  }
  open(id: number, target: OpenTarget): { id: string } {
    this.#entry(id);
    this.#o.revealMain();
    this.commands();
    const command = { id: crypto.randomUUID(), target, at: Date.now() };
    this.#pending.set(command.id, command);
    while (this.#pending.size > 20)
      this.#pending.delete(this.#pending.keys().next().value!);
    this.#o.command(command);
    return { id: command.id };
  }
  ack(id: string): void {
    if (!this.#pending.has(id)) return;
    for (const key of this.#pending.keys()) {
      this.#pending.delete(key);
      if (key === id) break;
    }
  }
  presented(id: number, key: string, visible: boolean): void {
    this.#entry(id);
    if (visible && this.seen(id)) this.#presentations.set(key, Date.now());
    for (const [k, at] of this.#presentations)
      if (Date.now() - at > 1500) this.#presentations.delete(k);
  }
  hasSeen(): boolean {
    return [...this.#entries.values()].some((entry) =>
      this.seen(entry.active.webContents.id)
    );
  }
  hasPresented(key: string): boolean {
    return (
      this.hasSeen() && Date.now() - (this.#presentations.get(key) ?? 0) <= 1500
    );
  }
  smokeOutcome(): import("../smoke").CompanionSmoke {
    if (this.#o.platform === "linux") return "n/a";
    if (!this.#o.prefs().notch?.enabled) return "disabled: off by pref";
    if (this.#failures.length > 0) return "failed";
    if ([...this.#entries.values()].some((entry) => entry.ready))
      return "ready";
    if (!this.#reconciled) return "pending";
    if (this.#metricsFailed) return "disabled: probe failed";
    if (this.#o.platform === "darwin") {
      const internal = screen.getAllDisplays().filter((d) => d.internal);
      if (!internal.length) return "disabled: no internal display";
      if (internal.every((d) => this.#metrics.get(metricsCacheKey(d)) === null))
        return "disabled: no cut-out";
    }
    return "pending";
  }
  status(): NotchStatus {
    const reason = !["darwin", "win32"].includes(this.#o.platform)
      ? "platform"
      : !this.#o.prefs().notch?.enabled
        ? "disabled"
        : this.#failures.filter((at) => Date.now() - at < 600_000).length >= 3
          ? "failed"
          : this.#metricsFailed
            ? "metrics-unavailable"
            : undefined;
    return {
      available: !reason && [...this.#entries.values()].some((e) => e.ready),
      ...(reason ? { reason } : {}),
      displays: this.#entries.size,
      shortcut: this.#shortcut,
    };
  }
  async retry(): Promise<NotchStatus> {
    this.#metrics.clear();
    this.#failures.length = 0;
    await this.reconcile();
    return this.status();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    for (const stop of this.#stops) stop();
    if (this.#space !== null)
      systemPreferences.unsubscribeWorkspaceNotification(this.#space);
    this.#clear();
    this.#haptics.dispose();
  }
}
