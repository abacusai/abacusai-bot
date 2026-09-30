/**
 * `agent.setModel`'s answer (spec 04 §26.4 d). `set_model` is a one-way
 * command; the agent answers on its stream with `model_changed` or an
 * `error` whose code is `model_unavailable`. Both wires reach main's compat
 * taps as `DesktopEvent`s, which feed this; the caller awaits the answer for
 * its session, and no answer within the timeout resolves (the pin applies
 * at the next start either way).
 */
import type { DesktopEvent } from "#shared/agent-types";

/** The agent refused the model; `message` is its own words. */
export class ModelUnavailableError extends Error {
  readonly reason = "model-unavailable";
}

export const MODEL_SWITCH_TIMEOUT_MS = 10_000;

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class ModelSwitchWaiters {
  readonly #waiting = new Map<string, Set<Waiter>>();

  /**
   * Registers before `send` runs, so an answer that arrives at once is not
   * missed. `send` false (no agent to tell) resolves at once.
   */
  wait(
    sessionId: string,
    send: () => boolean,
    timeoutMs: number = MODEL_SWITCH_TIMEOUT_MS
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        resolve: () => {
          done();
          resolve();
        },
        reject: (error) => {
          done();
          reject(error);
        },
      };
      const done = (): void => {
        clearTimeout(timer);
        const set = this.#waiting.get(sessionId);
        set?.delete(waiter);
        if (set?.size === 0) this.#waiting.delete(sessionId);
      };
      let set = this.#waiting.get(sessionId);
      if (set == null) {
        set = new Set();
        this.#waiting.set(sessionId, set);
      }
      set.add(waiter);
      timer = setTimeout(() => waiter.resolve(), timeoutMs);
      timer.unref?.();
      let sent: boolean;
      try {
        sent = send();
      } catch (error) {
        waiter.reject(
          error instanceof Error ? error : new Error(String(error))
        );
        return;
      }
      if (!sent) waiter.resolve();
    });
  }

  /** One agent event for `sessionId` (compat taps, both wires). */
  feed(sessionId: string, payload: DesktopEvent): void {
    const set = this.#waiting.get(sessionId);
    if (set == null || payload.type !== "event") return;
    const event = payload.event;
    if (event.type === "model_changed") {
      for (const waiter of set) waiter.resolve();
    } else if (
      event.type === "error" &&
      event.error?.code === "model_unavailable"
    ) {
      const error = new ModelUnavailableError(
        event.error.message ?? "That model is not available."
      );
      for (const waiter of set) waiter.reject(error);
    }
  }

  get pending(): number {
    return this.#waiting.size;
  }
}
