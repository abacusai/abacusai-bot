/**
 * The transport's lifecycle signal (spec 01 §8.6 step 8, §15.5):
 *
 * - `state` flips to `"closed"` before any listener runs;
 * - every registration fires exactly once, with the first close's reason;
 * - a listener added after closure fires once on the next microtask;
 * - later closes are ignored (so `close()` is idempotent).
 *
 * A throwing listener does not stop the others; its error is rethrown on a
 * microtask so it still reaches the global error handler.
 */
export type TransportState = "open" | "closed";

/** `port-closed`: the other end went away. `explicit`: our own `close()`. */
export type CloseReason = "port-closed" | "explicit";

export type CloseListener = (reason: CloseReason) => void;

export interface CloseSignal {
  readonly state: TransportState;
  onClose(listener: CloseListener): () => void;
  /** Close with this reason; a no-op once closed. */
  fire(reason: CloseReason): void;
}

export const createCloseSignal = (): CloseSignal => {
  let state: TransportState = "open";
  let closedWith: CloseReason = "explicit";
  // Registrations, not functions: the same function added twice fires twice.
  const pending = new Set<{ listener: CloseListener }>();

  const call = (listener: CloseListener, reason: CloseReason): void => {
    try {
      listener(reason);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  };

  return {
    get state() {
      return state;
    },
    onClose(listener) {
      if (state === "closed") {
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) call(listener, closedWith);
        });
        return () => {
          cancelled = true;
        };
      }
      const registration = { listener };
      pending.add(registration);
      return () => {
        pending.delete(registration);
      };
    },
    fire(reason) {
      if (state === "closed") return;
      state = "closed";
      closedWith = reason;
      const registrations = [...pending];
      pending.clear();
      for (const { listener } of registrations) call(listener, reason);
    },
  };
};
