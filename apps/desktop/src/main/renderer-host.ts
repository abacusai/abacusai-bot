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

export interface SwapOptions {
  /** Checked right before the flip; true rejects with SwapAborted. */
  shouldAbort?: () => boolean;
}

export interface RendererHostOptions {
  /** Matches the window's background so an unpainted view never flashes. */
  backgroundColor: string;
  webPreferences: WebPreferences;
  /** Runs on every renderer webContents this host creates. */
  wire: (contents: WebContents) => void;
  window: BaseWindow;
}

const SWAP_TIMEOUT_MS = 30_000;

/** Closing the window can destroy an attached view's contents first. */
const discard = (view: WebContentsView): void => {
  if (!view.webContents.isDestroyed()) view.webContents.close();
};

/**
 * Wait for the new renderer's first-commit signal, after which its IPC
 * subscriptions exist. A bundle that never signals still swaps after this.
 */
const READY_TIMEOUT_MS = 5_000;

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

const rendererReady = (
  contents: WebContents
): { cancel: () => void; promise: Promise<void> } => {
  let onMessage: ((event: unknown, channel: string) => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    onMessage = (_event: unknown, channel: string): void => {
      if (channel !== "renderer-ready") return;

      resolve();
    };
    contents.on("ipc-message", onMessage);
  });

  return {
    cancel: () => {
      if (onMessage !== undefined && !contents.isDestroyed()) {
        contents.off("ipc-message", onMessage);
      }
    },
    promise,
  };
};

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

const restoreContinuity = async (
  contents: WebContents,
  snapshot: unknown
): Promise<void> => {
  if (snapshot == null) return;

  try {
    await Promise.race([
      contents.executeJavaScript(
        `window.__restoreUiContinuity?.(${JSON.stringify(snapshot)})`
      ) as Promise<unknown>,
      delay(RESTORE_TIMEOUT_MS),
    ]);
  } catch {
    // A restore that cannot run degrades to a plain swap.
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

  dispose(): void {
    discard(this.#view);
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
    const ready = rendererReady(next.webContents);

    try {
      await Promise.race([
        next.webContents
          .loadURL(target.href)
          .then(() => Promise.race([ready.promise, delay(READY_TIMEOUT_MS)])),
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
      ready.cancel();
    }

    if (window.isDestroyed()) {
      discard(next);

      return false;
    }

    // Restore while still hidden, so the flip reveals a converged page.
    const continuity = await captureContinuity(current.webContents);

    await restoreContinuity(next.webContents, continuity);
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
export const sendToRenderer = (channel: string, ...args: unknown[]): void => {
  try {
    rendererWebContents()?.send(channel, ...args);
  } catch {
    // The renderer can go away between the check and the send.
  }
};
