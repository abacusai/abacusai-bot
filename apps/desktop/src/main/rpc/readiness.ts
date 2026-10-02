/**
 * The swap readiness barrier's main half (spec 00 A.4.6). A renderer built
 * for this contract calls `window.ready` once its transport, the shell's tables
 * and the visible thread are live; `RendererHost` waits on that, per
 * webContents, before it flips a swap candidate in.
 */
export type ReadinessReport =
  | { barrier: "subscriptions" }
  | { barrier: "failed"; reason: string };

export type ReadinessOutcome = "ready" | "failed" | "timeout";

interface Waiter {
  resolve: (outcome: ReadinessOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RendererReadiness {
  readonly #reports = new Map<number, ReadinessReport>();
  readonly #waiters = new Map<number, Set<Waiter>>();

  /** What `window.ready` calls. The first report per webContents wins. */
  report(webContentsId: number, report: ReadinessReport): void {
    if (this.#reports.has(webContentsId)) return;
    this.#reports.set(webContentsId, report);
    const outcome = report.barrier === "subscriptions" ? "ready" : "failed";
    for (const waiter of this.#waiters.get(webContentsId) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve(outcome);
    }
    this.#waiters.delete(webContentsId);
  }

  /** Resolves with the renderer's report, or `timeout` after `timeoutMs`. */
  wait(webContentsId: number, timeoutMs: number): Promise<ReadinessOutcome> {
    const reported = this.#reports.get(webContentsId);
    if (reported != null)
      return Promise.resolve(
        reported.barrier === "subscriptions" ? "ready" : "failed"
      );

    return new Promise((resolve) => {
      const waiters = this.#waiters.get(webContentsId) ?? new Set<Waiter>();
      this.#waiters.set(webContentsId, waiters);
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.#waiters.delete(webContentsId);
          resolve("timeout");
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      waiters.add(waiter);
    });
  }

  /** A reload starts over; a waiter keeps waiting for the new document. */
  forget(webContentsId: number): void {
    this.#reports.delete(webContentsId);
  }

  /**
   * The contents is gone: forget its report, and fail its waiters now
   * rather than at their timeout.
   */
  discard(webContentsId: number): void {
    this.#reports.delete(webContentsId);
    for (const waiter of this.#waiters.get(webContentsId) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve("failed");
    }
    this.#waiters.delete(webContentsId);
  }
}

export const rendererReadiness = new RendererReadiness();
