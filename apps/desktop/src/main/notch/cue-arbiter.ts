/**
 * Central attention-cue arbitration (spec 06 §14.2, F18): several documents
 * (the main renderer, one notch document per display) see the same notices,
 * and exactly one of them may play each cue.
 *
 * - **Focused-thread silence first.** A claim for the thread the main window
 *   shows while it is focused (`window.visibleThread`) is declined and
 *   recorded as suppressed; the fallback never grants it later.
 * - **Who may claim.** Only a document that can play (`canPlay`): the main
 *   renderer, or an active, ready, unlocked and seen notch document. Anyone
 *   else is answered `false` at once.
 * - **Per-cue claim.** The first claim from the audible document wins. If
 *   the audible document has not claimed within `fallbackMs`, the earliest
 *   other claimant that is still eligible at grant time (rechecked then) is
 *   granted, in arrival order; if none is, the cue is dropped. Every other
 *   claim gets `false`.
 * - The decision map is bounded (`maxEntries`, `ttlMs`). A decided cue
 *   evicted by the count bound leaves a tombstone until its TTL, so the same
 *   cue id is never granted twice.
 *
 * No Electron import: the window facts come in as functions, so the notch
 * phase plugs its documents in without touching the rules.
 */

export interface CueArbiterWindows {
  /** The live main renderer's webContents id. */
  mainRendererId(): number | null;
  /** Whether the main window is focused. */
  mainFocused(): boolean;
  /**
   * The one document main chose to be audible now (spec 06 §14.2): the main
   * renderer unless a notch document is. Null when none can play.
   */
  audible(): number | null;
  /** Whether `webContentsId` may play a cue right now (rechecked at grant). */
  canPlay(webContentsId: number): boolean;
}

export interface CueArbiterOptions {
  windows: CueArbiterWindows;
  fallbackMs?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /**
   * Calls `forget` once the window `webContentsId` is gone (its webContents
   * `destroyed`), so a window's visibility report does not outlive it.
   */
  onWindowGone?: (webContentsId: number, forget: () => void) => void;
}

export type CueDecision = "granted" | "suppressed" | "dropped";

interface Waiting {
  webContentsId: number;
  resolve: (play: boolean) => void;
}

interface Entry {
  at: number;
  /** The thread the first claim named (suppression is rechecked at grant). */
  threadId: string | null;
  decision: CueDecision | null;
  /** Non-audible eligible claimants, in arrival order. */
  waiting: Waiting[];
  timer: unknown;
  grantedTo: number | null;
}

/**
 * The window facts before the notch exists (phase 6 adds its documents):
 * the main renderer is the only document that can play, and so the audible
 * one whenever it is live.
 */
export const mainOnlyCueWindows = (windows: {
  mainRendererId(): number | null;
  state(webContentsId: number): { focused: boolean } | null;
}): CueArbiterWindows => ({
  mainRendererId: () => windows.mainRendererId(),
  mainFocused: () => {
    const main = windows.mainRendererId();
    return main != null && windows.state(main)?.focused === true;
  },
  audible: () => windows.mainRendererId(),
  canPlay: (webContentsId) => webContentsId === windows.mainRendererId(),
});

export const CUE_FALLBACK_MS = 1_000;
export const CUE_ENTRIES_KEPT = 1_000;
export const CUE_TTL_MS = 10 * 60_000;

export class CueArbiter {
  readonly #windows: CueArbiterWindows;
  readonly #fallbackMs: number;
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #onWindowGone:
    | ((webContentsId: number, forget: () => void) => void)
    | undefined;
  readonly #entries = new Map<string, Entry>();
  /** Decided cue ids evicted by the count bound → when they were first seen. */
  readonly #tombstones = new Map<string, number>();
  /** webContentsId → the thread that main window reports it shows. */
  readonly #visible = new Map<number, string | null>();

  constructor(options: CueArbiterOptions) {
    this.#windows = options.windows;
    this.#fallbackMs = options.fallbackMs ?? CUE_FALLBACK_MS;
    this.#maxEntries = options.maxEntries ?? CUE_ENTRIES_KEPT;
    this.#ttlMs = options.ttlMs ?? CUE_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ?? ((run, ms) => setTimeout(run, ms).unref?.());
    this.#clearTimer =
      options.clearTimer ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.#onWindowGone = options.onWindowGone;
  }

  /** `window.visibleThread`: the thread a main window shows (null: none). */
  setVisibleThread(webContentsId: number, threadId: string | null): void {
    const known = this.#visible.has(webContentsId);
    this.#visible.set(webContentsId, threadId);
    if (!known)
      this.#onWindowGone?.(webContentsId, () =>
        this.forgetWindow(webContentsId)
      );
  }

  /** How many windows' visibility reports are kept (diagnostics, tests). */
  get trackedWindows(): number {
    return this.#visible.size;
  }

  /** A window is gone: its visibility report goes with it. */
  forgetWindow(webContentsId: number): void {
    this.#visible.delete(webContentsId);
  }

  /** What was decided for a cue, if anything yet (tests, diagnostics). */
  decision(cueId: string): CueDecision | null {
    return this.#entries.get(cueId)?.decision ?? null;
  }

  /** `window.claimCue`: resolves `true` for exactly one caller per cue. */
  claim(
    webContentsId: number,
    cueId: string,
    threadId: string | null
  ): Promise<boolean> {
    this.#prune();
    if (this.#tombstones.has(cueId)) return Promise.resolve(false);
    let entry = this.#entries.get(cueId);
    if (entry == null) {
      entry = {
        at: this.#now(),
        threadId,
        decision: null,
        waiting: [],
        timer: null,
        grantedTo: null,
      };
      this.#entries.set(cueId, entry);
    }
    if (entry.decision != null) return Promise.resolve(false);

    entry.threadId ??= threadId;

    // Focused-thread silence, before any other rule.
    if (this.#suppressed(threadId)) {
      this.#decide(entry, "suppressed");
      return Promise.resolve(false);
    }

    if (!this.#windows.canPlay(webContentsId)) return Promise.resolve(false);

    if (webContentsId === this.#windows.audible()) {
      entry.grantedTo = webContentsId;
      this.#decide(entry, "granted");
      return Promise.resolve(true);
    }

    // Not the audible document: it waits for the fallback.
    const current = entry;
    return new Promise<boolean>((resolve) => {
      current.waiting.push({ webContentsId, resolve });
      current.timer ??= this.#setTimer(
        () => this.#fallback(current),
        this.#fallbackMs
      );
    });
  }

  /** The main window is focused on `threadId`: its cues stay silent. */
  #suppressed(threadId: string | null): boolean {
    const main = this.#windows.mainRendererId();
    return (
      threadId != null &&
      main != null &&
      this.#windows.mainFocused() &&
      this.#visible.get(main) === threadId
    );
  }

  #fallback(entry: Entry): void {
    entry.timer = null;
    if (entry.decision != null) return;
    // Main may have focused the cue's thread during the wait.
    if (this.#suppressed(entry.threadId)) {
      this.#decide(entry, "suppressed");
      return;
    }
    const waiting = entry.waiting;
    entry.waiting = [];
    // Rechecked now: a claimant disposed or locked since it asked is skipped.
    const winner = waiting.find((claim) =>
      this.#windows.canPlay(claim.webContentsId)
    );
    if (winner == null) {
      entry.decision = "dropped";
    } else {
      entry.decision = "granted";
      entry.grantedTo = winner.webContentsId;
    }
    for (const claim of waiting) claim.resolve(claim === winner);
  }

  #decide(entry: Entry, decision: CueDecision): void {
    entry.decision = decision;
    if (entry.timer != null) this.#clearTimer(entry.timer);
    entry.timer = null;
    const waiting = entry.waiting;
    entry.waiting = [];
    for (const claim of waiting) claim.resolve(false);
  }

  #prune(): void {
    const now = this.#now();
    for (const [cueId, at] of this.#tombstones) {
      if (now - at <= this.#ttlMs) break;
      this.#tombstones.delete(cueId);
    }
    for (const [cueId, entry] of this.#entries) {
      const expired = now - entry.at > this.#ttlMs;
      if (this.#entries.size <= this.#maxEntries && !expired) break;
      // Insertion order is age order; an undecided cue past its time drops.
      if (entry.decision == null) this.#decide(entry, "dropped");
      this.#entries.delete(cueId);
      // Evicted early by the count bound: remember it was decided.
      if (!expired) this.#tombstones.set(cueId, entry.at);
    }
  }
}
