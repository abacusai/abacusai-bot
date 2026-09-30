/**
 * `agent.setModel`'s answer (spec 04 §26.4 d). `set_model` is a one-way
 * command; the agent answers on its stream with `model_changed` or an
 * `error` whose code is `model_unavailable`. Both wires reach main's compat
 * taps as `DesktopEvent`s, which feed this.
 *
 * The agent handles each command without awaiting the previous one, and a
 * refusal names no model, so two switches in flight at once cannot be told
 * apart. Every switch for a session (the checked RPC, the legacy
 * fire-and-forget one and a bot re-pin alike) therefore goes through one
 * queue per session: one `set_model` is outstanding at a time, the next is
 * written only once it is answered or its process is invalidated. An answer settles
 * only the outstanding switch — `model_changed` only when it names the
 * requested model (an OpenLLM rotation or a startup notice settles
 * nothing). No answer within the timeout resolves (the pin applies at the
 * next start either way); an agent without a model runtime answers nothing,
 * so its caller waits only until the deadline, while subsequent commands
 * remain queued until a response or process invalidation.
 */
import type { DesktopEvent } from "#shared/agent-types";

/** The agent refused the model; `message` is its own words. */
export class ModelUnavailableError extends Error {
  readonly reason = "model-unavailable";
}

export const MODEL_SWITCH_TIMEOUT_MS = 10_000;

interface Switch {
  model: string;
  send: () => boolean;
  timeoutMs: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

/**
 * Whether `reported` (the agent's `provider/id`) is the switch to
 * `requested`: the same id, or a bare id the agent qualified.
 */
const answers = (requested: string, reported: string): boolean =>
  reported === requested ||
  (!requested.includes("/") && reported.endsWith(`/${requested}`));

export class ModelSwitchWaiters {
  /** Per session: the outstanding switch first, then those queued. */
  readonly #queues = new Map<string, Switch[]>();

  /**
   * One switch to `model`, answered or timed out. Written at once when
   * nothing is outstanding for the session (so an answer that arrives at
   * once is not missed), else after the ones before it. `send` false (no
   * agent to tell) resolves at once; a throwing `send` rejects.
   */
  wait(
    sessionId: string,
    model: string,
    send: () => boolean,
    timeoutMs: number = MODEL_SWITCH_TIMEOUT_MS
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#enqueue(sessionId, {
        model,
        send,
        timeoutMs,
        resolve,
        reject,
        settled: false,
      });
    });
  }

  /**
   * The fire-and-forget switch (legacy `setAgentModel`, a bot re-pin): the
   * same queue, so its answer is not taken for another's. When it is written
   * at once a throwing `send` throws here, as it always has.
   */
  post(
    sessionId: string,
    model: string,
    send: () => boolean,
    timeoutMs: number = MODEL_SWITCH_TIMEOUT_MS
  ): void {
    const thrown: { error?: unknown; set: boolean } = { set: false };
    const now = (this.#queues.get(sessionId)?.length ?? 0) === 0;
    this.#enqueue(sessionId, {
      model,
      send: () => {
        try {
          return send();
        } catch (error) {
          if (now) Object.assign(thrown, { error, set: true });
          return false;
        }
      },
      timeoutMs,
      resolve: () => undefined,
      reject: () => undefined,
      settled: false,
    });
    if (thrown.set) throw thrown.error;
  }

  #enqueue(sessionId: string, entry: Switch): void {
    let queue = this.#queues.get(sessionId);
    if (queue == null) {
      queue = [];
      this.#queues.set(sessionId, queue);
    }
    queue.push(entry);
    if (queue.length === 1) this.#dispatch(sessionId);
  }

  /** Writes the head switch; one that needs no answer settles at once. */
  #dispatch(sessionId: string): void {
    const head = this.#queues.get(sessionId)?.[0];
    if (head == null) return;
    head.timer = setTimeout(
      // The caller's deadline cannot retire an anonymous command: its
      // late refusal must still belong to this head, never the next caller.
      () => head.resolve(),
      head.timeoutMs
    );
    head.timer.unref?.();
    let sent: boolean;
    try {
      sent = head.send();
    } catch (error) {
      this.#settle(
        sessionId,
        head,
        error instanceof Error ? error : new Error(String(error))
      );
      return;
    }
    if (!sent) this.#settle(sessionId, head, null);
  }

  #settle(sessionId: string, entry: Switch, error: Error | null): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    const queue = this.#queues.get(sessionId);
    if (queue != null) {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      if (queue.length === 0) this.#queues.delete(sessionId);
    }
    if (error == null) entry.resolve();
    else entry.reject(error);
    // The next switch goes out only now that this one is answered.
    if (queue != null && queue.length > 0) this.#dispatch(sessionId);
  }

  /** The process stopped or was replaced. Stored pins apply on next start. */
  invalidate(sessionId: string): void {
    const queue = this.#queues.get(sessionId);
    this.#queues.delete(sessionId);
    for (const entry of queue ?? []) {
      entry.settled = true;
      clearTimeout(entry.timer);
      entry.resolve();
    }
  }

  /** One agent event for `sessionId` (compat taps, both wires). */
  feed(sessionId: string, payload: DesktopEvent): void {
    const head = this.#queues.get(sessionId)?.[0];
    if (head == null || payload.type !== "event") return;
    const event = payload.event;
    if (event.type === "model_changed") {
      if (answers(head.model, event.model)) this.#settle(sessionId, head, null);
    } else if (
      event.type === "error" &&
      event.error?.code === "model_unavailable"
    ) {
      this.#settle(
        sessionId,
        head,
        new ModelUnavailableError(
          event.error.message ?? "That model is not available."
        )
      );
    }
  }

  get pending(): number {
    return this.#queues.size;
  }
}
