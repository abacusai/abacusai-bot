/**
 * The renderer lives in a WebContentsView on a BaseWindow so an experience
 * update can load the new bundle in a second view and swap once it has
 * painted: no navigation, no flash, route fragment carried over.
 */
import { WebContentsView } from "electron";
import type { BaseWindow, WebContents, WebPreferences } from "electron";

/** The swap stood down (shouldAbort said so); retrying later is expected. */
export class SwapAborted extends Error {
  constructor() {
    super("The user became active; the swap stood down");
    this.name = "SwapAborted";
  }
}

/**
 * A swap candidate built for the oRPC contract did not pass its readiness
 * barrier: it reported `failed`, or nothing within SWAP_READY_TIMEOUT_MS. The
 * candidate is discarded and the old renderer keeps running.
 */
export class SwapNotReady extends Error {
  constructor(readonly outcome: "failed" | "timeout") {
    super(`The new renderer did not become ready (${outcome})`);
    this.name = "SwapNotReady";
  }
}

/**
 * What a candidate must reach before the flip. `subscriptions` is the legacy
 * renderer's `window.ready` within SWAP_READY_TIMEOUT_MS.
 * `subscriptions` is the oRPC renderer's `window.ready` barrier: transport,
 * shell tables and visible thread live (spec 00 A.4.6).
 */
export type SwapBarrier = "subscriptions";

export interface SwapOptions {
  /** Checked right before the flip; true rejects with SwapAborted. */
  shouldAbort?: () => boolean;
  /** Only the subscriptions barrier is supported. */
  barrier?: SwapBarrier;
}

export type ReadinessOutcome = "ready" | "failed" | "timeout";

/** Where `window.ready` reports land (main/rpc/readiness.ts). */
export interface RendererReadinessSource {
  wait(webContentsId: number, timeoutMs: number): Promise<ReadinessOutcome>;
}

export interface RendererHostOptions {
  /** Matches the window's background so an unpainted view never flashes. */
  backgroundColor: string;
  webPreferences: WebPreferences;
  /** Runs on every renderer webContents this host creates. */
  wire: (contents: WebContents) => void;
  window: BaseWindow;
  /** Required for the `subscriptions` barrier. */
  readiness?: RendererReadinessSource;
}

/** A swap candidate's load, and a new window's first document's readiness. */
export const SWAP_TIMEOUT_MS = 30_000;

/** Closing the window can destroy an attached view's contents first. */
const discard = (view: WebContentsView): void => {
  if (!view.webContents.isDestroyed()) view.webContents.close();
};

/**
 * Wait for the new renderer's subscription readiness, after which its IPC
 * subscriptions exist. A bundle that never signals within this is not ready
 * (`SwapNotReady("timeout")`), and the old renderer stays.
 */

/** How long an oRPC-contract candidate has to report ready after loading. */
export const SWAP_READY_TIMEOUT_MS = 10_000;

/** Readiness failures tolerated per version before swaps stop until relaunch. */
export const MAX_SWAP_READINESS_ATTEMPTS = 3;

/**
 * Counts readiness failures per version: a candidate that cannot become
 * ready is retried at the next idle window, at most
 * MAX_SWAP_READINESS_ATTEMPTS times, then left alone until the next launch.
 */
export class SwapRetryBudget {
  readonly #failures = new Map<string, number>();

  constructor(readonly max = MAX_SWAP_READINESS_ATTEMPTS) {}

  /** Record one failure; true while another attempt is allowed. */
  fail(version: string): boolean {
    const failures = (this.#failures.get(version) ?? 0) + 1;
    this.#failures.set(version, failures);
    return failures < this.max;
  }

  /** Whether another attempt is allowed, before making it. */
  allows(version: string): boolean {
    return this.failures(version) < this.max;
  }

  failures(version: string): number {
    return this.#failures.get(version) ?? 0;
  }
}

/** How often a pending swap looks for a quiet moment. */
export const SWAP_IDLE_POLL_MS = 5_000;

export interface RendererSwapSchedulerOptions {
  /**
   * The bundle to swap to for `version`: its renderer URL while it is still
   * the active experience, else null (a newer activation superseded it, and
   * nothing is left to settle for it).
   */
  target(version: string): URL | null | undefined;
  host(): Pick<RendererHost, "swap"> | null;
  /** An agent turn, a live terminal or recent input: not now. */
  busy(): boolean;
  barrier: SwapBarrier;
  /** Development stays on its dev server. */
  disabled?: () => boolean;
  budget?: SwapRetryBudget;
  pollMs?: number;
  log?: Pick<Console, "log" | "warn" | "error">;
  /**
   * How a scheduled version ended (spec 07 review r1 #9): `swapped` (it
   * passed readiness, by a swap or as a new window's first document),
   * `skipped` (development: nothing is ever swapped) or `gave-up` (it never
   * became ready within the budget). The experience store commits on the
   * first two and rolls back on the third. `live` is true when the renderer
   * that gave up is the one on screen (a new window loaded it), so the
   * window must be reloaded once the rollback is done.
   */
  onOutcome?: (
    version: string,
    outcome: SwapOutcome,
    detail?: { live: boolean }
  ) => void;
}

export type SwapOutcome = "swapped" | "skipped" | "gave-up";

/**
 * Swaps to a newly activated renderer bundle at the first quiet moment, and
 * retries one that did not become ready, or failed to load, at a later
 * quiet moment (never in the same tick), at most MAX_SWAP_READINESS_ATTEMPTS
 * times per bundle URL: the budget is keyed and checked on the URL actually
 * swapped to, before the swap, so a version whose URL changed is not charged
 * for another's failures and an exhausted one is not attempted again.
 *
 * One version is outstanding at a time: scheduling another supersedes it,
 * and a superseded version's in-flight result is ignored. With no window
 * the version waits (deferred) for the next window, whose first document
 * is that bundle: `adopt` settles it on that document's readiness.
 */
export class RendererSwapScheduler {
  readonly #options: RendererSwapSchedulerOptions;
  readonly #budget: SwapRetryBudget;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** The version waiting to settle, or null. */
  #version: string | null = null;
  /** Waiting for a new window (none was up, or it went away mid-swap). */
  #deferred = false;
  #adoption: symbol | null = null;

  constructor(options: RendererSwapSchedulerOptions) {
    this.#options = options;
    this.#budget = options.budget ?? new SwapRetryBudget();
  }

  /** A retry is armed, or the version waits for the next window. */
  get pending(): boolean {
    return this.#timer != null || this.#deferred;
  }

  /** The version waiting to settle, or null. */
  get outstanding(): string | null {
    return this.#version;
  }

  /** `deferred`: wait for the next idle tick before the first attempt. */
  schedule(version: string, { deferred = false } = {}): void {
    this.#version = version;
    this.#adoption = null;
    this.#deferred = false;
    this.#arm(version, deferred);
  }

  cancel(): void {
    if (this.#timer != null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * A new window was created and loads the active bundle as its first
   * document: the outstanding version (if any) settles on that document's
   * readiness instead of a swap. Call it before the window starts loading.
   */
  adopt(host: Pick<RendererHost, "initialReadiness">): void {
    const version = this.#version;
    if (version == null) return;
    this.cancel();
    const adoption = Symbol();
    this.#adoption = adoption;
    this.#deferred = true;
    if (this.#options.disabled?.() === true) {
      this.#settle(version, "skipped");
      return;
    }
    host.initialReadiness(this.#options.barrier).then(
      (ready) => {
        if (this.#version !== version || this.#adoption !== adoption) return;
        if (ready == null) return; // Closed: wait for another window.
        if (ready) this.#settle(version, "swapped");
        else {
          (this.#options.log ?? console).warn(
            `[experience] ${version} did not become ready in the new window`
          );
          this.#settle(version, "gave-up", { live: true });
        }
      },
      () => {
        if (this.#version === version && this.#adoption === adoption)
          this.#settle(version, "gave-up", { live: true });
      }
    );
  }

  #arm(version: string, deferred: boolean): void {
    this.cancel();
    if (!deferred && this.#attempt(version)) return;
    const timer = setInterval(() => {
      if (this.#attempt(version) && this.#timer === timer) this.cancel();
    }, this.#options.pollMs ?? SWAP_IDLE_POLL_MS);
    timer.unref?.();
    this.#timer = timer;
  }

  #settle(
    version: string,
    outcome: SwapOutcome,
    detail?: { live: boolean }
  ): void {
    if (this.#version !== version) return;
    this.#version = null;
    this.#adoption = null;
    this.#deferred = false;
    this.cancel();
    try {
      this.#options.onOutcome?.(version, outcome, detail);
    } catch (error) {
      (this.#options.log ?? console).error(
        "[experience] the swap outcome handler failed",
        error
      );
    }
  }

  /** True when there is nothing left to wait for on the timer. */
  #attempt(version: string): boolean {
    const options = this.#options;
    const log = options.log ?? console;
    // Superseded: the newer version's own schedule settles it.
    if (this.#version !== version) return true;
    if (options.disabled?.() === true) {
      this.#settle(version, "skipped");
      return true;
    }
    const url = options.target(version);
    if (!url) {
      // No longer the active experience: nothing to settle for it.
      this.#version = null;
      return true;
    }
    const host = options.host();
    if (host == null) {
      // Neither ready nor rejected: the next window's first document is
      // this bundle, and `adopt` settles it.
      this.#deferred = true;
      return true;
    }
    const key = url.href;
    if (!this.#budget.allows(key)) {
      log.warn(
        `[experience] ${version} never became ready; no more swaps until relaunch`
      );
      this.#settle(version, "gave-up");
      return true;
    }
    if (options.busy()) return false;

    host
      .swap(url, {
        shouldAbort: () =>
          options.busy() ||
          this.#version !== version ||
          options.target(version)?.href !== key,
        barrier: options.barrier,
      })
      .then(
        (swapped) => {
          if (this.#version !== version) return;
          if (swapped) {
            log.log(`[experience] renderer swapped to ${version}`);
            this.#settle(version, "swapped");
          } else {
            // The window went away mid-swap: the next one settles it.
            this.#deferred = true;
          }
        },
        (error: unknown) => {
          if (this.#version !== version) return;
          if (error instanceof SwapAborted) {
            this.#arm(version, false);
            return;
          }
          if (!(error instanceof SwapNotReady))
            log.error("[experience] renderer swap failed", error);
          // A readiness failure, a rejected load and a load timeout all
          // count against the budget.
          if (this.#budget.fail(key)) this.#arm(version, true);
          else {
            log.warn(
              `[experience] ${version} never became ready; no more swaps until relaunch`
            );
            this.#settle(version, "gave-up");
          }
        }
      );
    return true;
  }
}

/** The old renderer answers the continuity capture within this, or not. */
const CAPTURE_TIMEOUT_MS = 3_000;

/** The candidate applies the continuity snapshot within this, or not. */
const RESTORE_TIMEOUT_MS = 2_000;

/** Room for React to re-render what the restore changed, before the flip. */
const SETTLE_MS = 300;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/**
 * Focus, caret and scroll cross the swap via globals from ui-continuity.ts.
 * Best-effort: anything missing or unanswered degrades to a plain swap.
 */
const captureContinuity = async (contents: WebContents): Promise<unknown> => {
  try {
    return await Promise.race([
      contents.executeJavaScript(
        "window.__captureUiContinuity ? window.__captureUiContinuity() : null"
      ) as Promise<unknown>,
      delay(CAPTURE_TIMEOUT_MS).then(() => null),
    ]);
  } catch {
    return null;
  }
};

export const restoreContinuity = async (
  contents: WebContents,
  snapshot: unknown
): Promise<"restored" | "timeout" | "none"> => {
  if (snapshot == null) return "none";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      contents.executeJavaScript(
        `window.__restoreUiContinuity ? Promise.resolve(window.__restoreUiContinuity(${JSON.stringify(snapshot)})).then(() => "restored") : "none"`
      ) as Promise<"restored" | "none">,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), RESTORE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch {
    return "none";
  } finally {
    clearTimeout(timer);
  }
};

export class RendererHost {
  #swaps: Promise<void> = Promise.resolve();
  #view: WebContentsView;
  readonly #options: RendererHostOptions;

  constructor(options: RendererHostOptions) {
    this.#options = options;
    this.#view = this.#create();
    options.window.contentView.addChildView(this.#view);
    this.#fit(this.#view);
    options.window.on("resize", () => {
      this.#fit(this.#view);
    });
  }

  /** The live renderer's webContents. A swap replaces it. */
  get webContents(): WebContents {
    return this.#view.webContents;
  }

  setBackgroundColor(color: string): void {
    this.#options.backgroundColor = color;
    this.#view.setBackgroundColor(color);
  }

  dispose(): void {
    discard(this.#view);
  }

  /**
   * The oRPC renderer's readiness report for `contents`, or `timeout` after
   * SWAP_READY_TIMEOUT_MS. Without a readiness source nothing can report, so
   * it is `failed`.
   */
  readiness(contents: WebContents): Promise<ReadinessOutcome> {
    const source = this.#options.readiness;
    return source == null
      ? Promise.resolve("failed")
      : source.wait(contents.id, SWAP_READY_TIMEOUT_MS);
  }

  /**
   * Whether the live renderer's first document (a new window's) reaches
   * `barrier` within SWAP_TIMEOUT_MS of this call: `window.ready` for
   * `subscriptions`, a `window.ready` report for `subscriptions`. Call it
   * before the document starts loading. Null means the window closed,
   * so activation can wait for its replacement.
   */
  async initialReadiness(barrier: SwapBarrier): Promise<boolean | null> {
    const contents = this.#view.webContents;
    const destroyed = () =>
      contents.isDestroyed() || this.#options.window.isDestroyed();
    if (destroyed()) return null;
    let onDestroyed: () => void = () => undefined;
    const closed = new Promise<null>((resolve) => {
      onDestroyed = () => resolve(null);
      contents.on("destroyed", onDestroyed);
    });
    void barrier;
    try {
      const readiness =
        this.#options.readiness == null
          ? Promise.resolve(false)
          : this.#options.readiness
              .wait(contents.id, SWAP_TIMEOUT_MS)
              .then((outcome) => outcome === "ready");
      const outcome = await Promise.race([readiness, closed]);
      return destroyed() ? null : outcome;
    } catch (error) {
      if (destroyed()) return null;
      throw error;
    } finally {
      contents.off("destroyed", onDestroyed);
    }
  }

  /**
   * Replace the renderer with `url`, keeping the route. On failure the old
   * renderer keeps running. Serialized; false when the window went away.
   */
  swap(url: URL, options?: SwapOptions): Promise<boolean> {
    const run = this.#swaps.then(
      () => this.#swap(url, options),
      () => this.#swap(url, options)
    );

    this.#swaps = run.catch(() => undefined);

    return run;
  }

  #create(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: this.#options.webPreferences,
    });

    view.setBackgroundColor(this.#options.backgroundColor);
    this.#options.wire(view.webContents);

    return view;
  }

  #fit(view: WebContentsView): void {
    const { height, width } = this.#options.window.getContentBounds();

    view.setBounds({ height, width, x: 0, y: 0 });
  }

  async #swap(url: URL, options?: SwapOptions): Promise<boolean> {
    const { window } = this.#options;

    if (window.isDestroyed()) return false;

    const current = this.#view;
    const target = new URL(url.href);
    const currentUrl = current.webContents.getURL();
    const separator = currentUrl.indexOf("#");

    if (separator !== -1) {
      target.hash = currentUrl.slice(separator);
    }

    const next = this.#create();

    // Loads under the opaque live view (and below browser panes) until the
    // flip; the shared background color keeps the swap from flashing.
    const index = window.contentView.children.indexOf(current);

    window.contentView.addChildView(next, Math.max(index, 0));
    next.setBounds(current.getBounds());

    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        next.webContents.loadURL(target.href).then(async () => {
          // No flip on a guess: a candidate that never says its data is
          // live, or says it failed, is discarded (its port closes with it).
          const outcome = await this.readiness(next.webContents);
          if (outcome !== "ready") throw new SwapNotReady(outcome);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `The new renderer did not load within ${SWAP_TIMEOUT_MS}ms`
              )
            );
          }, SWAP_TIMEOUT_MS);
          timer.unref();
        }),
      ]);

      if (options?.shouldAbort?.() === true) {
        throw new SwapAborted();
      }
    } catch (error) {
      if (!window.isDestroyed()) {
        window.contentView.removeChildView(next);
      }

      discard(next);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (window.isDestroyed()) {
      discard(next);

      return false;
    }

    // Restore while still hidden, so the flip reveals a converged page.
    const continuity = await captureContinuity(current.webContents);

    if (
      continuity != null &&
      typeof continuity === "object" &&
      (continuity as { tooLarge?: boolean }).tooLarge === true
    ) {
      window.contentView.removeChildView(next);
      discard(next);
      throw new SwapAborted();
    }
    const restored = await restoreContinuity(next.webContents, continuity);
    console.log(`[experience] continuity restore: ${restored}`);
    await delay(SETTLE_MS);

    if (window.isDestroyed()) {
      discard(next);

      return false;
    }

    if (options?.shouldAbort?.() === true) {
      window.contentView.removeChildView(next);
      discard(next);
      throw new SwapAborted();
    }

    next.setBackgroundColor(this.#options.backgroundColor);
    const focused = current.webContents.isFocused();

    this.#view = next;
    this.#fit(next);
    window.contentView.removeChildView(current);

    if (focused) next.webContents.focus();

    current.webContents.close();

    return true;
  }
}

let active: RendererHost | null = null;

export const setActiveRendererHost = (host: RendererHost | null): void => {
  active = host;
};

/** The app's renderer webContents, or null when no window is up. */
export const rendererWebContents = (): WebContents | null => {
  const contents = active?.webContents;

  return contents !== undefined && !contents.isDestroyed() ? contents : null;
};

/**
 * Reaches only the app's renderer: getAllWindows() would also message the
 * connectors' hidden BrowserWindows.
 */
