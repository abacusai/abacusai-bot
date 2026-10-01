import type { NotchShape } from "#shared/contract/notch";

import type { NotchPresentation } from "./presenter";
export interface Shape {
  width: number;
  height: number;
}
export const shapeSettled = (
  element: HTMLElement,
  from: Shape,
  to: Shape,
  reduced: boolean,
  signal: AbortSignal
): Promise<void> => {
  if (
    reduced ||
    (from.width === to.width && from.height === to.height) ||
    signal.aborted
  )
    return Promise.resolve();
  return new Promise((resolve) => {
    const remaining = new Set([
      ...(from.width !== to.width ? ["width"] : []),
      ...(from.height !== to.height ? ["height"] : []),
    ]);
    const finish = () => {
      clearTimeout(timer);
      element.removeEventListener("transitionend", end);
      element.removeEventListener("transitioncancel", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const end = (event: TransitionEvent) => {
      if (event.target !== element) return;
      remaining.delete(event.propertyName);
      if (!remaining.size) finish();
    };
    const timer = setTimeout(finish, 450); // canvas 350 ms + spec deadline margin 100 ms
    element.addEventListener("transitionend", end);
    element.addEventListener("transitioncancel", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
};
export interface DirectorDeps {
  load(id: string, signal: AbortSignal): Promise<void>;
  retire(id: string): void;
  setShape(shape: NotchShape, signal?: AbortSignal): Promise<unknown>;
  navigate(presentation: NotchPresentation): Promise<void>;
  settle(from: Shape, to: Shape, signal: AbortSignal): Promise<void>;
  renderedSize(): Shape;
  audio(): boolean;
  commit(p: NotchPresentation, shape: Shape): void;
}
export class NotchDirector {
  #gen = 0;
  #abort: AbortController | null = null;
  #held = new Set<string>();
  #unavailable = new Map<string, number>();
  #current: NotchPresentation | null = null;
  #queued: { p: NotchPresentation; shape: Shape } | null = null;
  #locked = false;
  #latest: { p: NotchPresentation; shape: Shape } | null = null;
  constructor(readonly deps: DirectorDeps) {}
  lock(locked: boolean): void {
    this.#locked = locked;
    if (!locked && this.#queued) {
      const next = this.#queued;
      this.#queued = null;
      const latest = this.#latest;
      if (
        latest &&
        latest.p.identity === next.p.identity &&
        !latest.p.quietUntil &&
        latest.p.route !== "/idle" &&
        latest.p.queue.some(
          (item) =>
            item.sessionId === next.p.sessionId &&
            (item.descriptorId ?? item.runId) ===
              (next.p.attention?.descriptorId ?? next.p.attention?.runId)
        )
      )
        void this.present(latest.p, latest.shape).catch(() => undefined);
    }
  }
  async present(p: NotchPresentation, shape: Shape): Promise<void> {
    this.#latest = { p, shape };
    const valid =
      this.#current &&
      p.queue.some(
        (item) =>
          !item.snoozed &&
          item.sessionId === this.#current?.sessionId &&
          (item.descriptorId ?? item.runId ?? "") ===
            (this.#current?.attention?.descriptorId ??
              this.#current?.attention?.runId ??
              "")
      );
    if (
      this.#locked &&
      this.#current &&
      valid &&
      !p.quietUntil &&
      p.route !== "/idle" &&
      p.identity !== this.#current.identity
    ) {
      this.#queued = { p, shape };
      return;
    }
    this.#queued = null;
    const gen = ++this.#gen;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, 8000);
    const bounded = <T>(work: Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const cancelled = () =>
          reject(new DOMException("Presentation cancelled", "AbortError"));
        if (abort.signal.aborted) {
          cancelled();
          return;
        }
        abort.signal.addEventListener("abort", cancelled, { once: true });
        work
          .then(resolve, reject)
          .finally(() => abort.signal.removeEventListener("abort", cancelled));
      });
    const current = () => gen === this.#gen && !abort.signal.aborted;
    const held = new Set<string>();
    if (
      ["/approval/$id", "/reply/$id"].includes(p.route) &&
      p.attention?.kind !== "connector-ask" &&
      p.sessionId
    )
      held.add(p.sessionId);
    const next = p.queue.find(
      (item) =>
        !item.snoozed &&
        item.sessionId !== p.sessionId &&
        ["question", "approval", "reply"].includes(item.kind)
    );
    if (next) held.add(next.sessionId);
    for (const id of this.#held) if (!held.has(id)) this.deps.retire(id);
    this.#held = held;
    try {
      if (p.sessionId && held.has(p.sessionId)) {
        if ((this.#unavailable.get(p.sessionId) ?? 0) > Date.now())
          p = { ...p, expanded: false };
        else {
          try {
            await bounded(this.deps.load(p.sessionId, abort.signal));
          } catch {
            if (gen !== this.#gen) return;
            if (timedOut) throw new DOMException("Deadline", "AbortError");
            this.#unavailable.set(p.sessionId, Date.now() + 30_000);
            this.deps.retire(p.sessionId);
            held.delete(p.sessionId);
            p = { ...p, expanded: false };
          }
          if (gen !== this.#gen) return;
        }
      }
      if (!current()) return;
      const from = this.deps.renderedSize();
      const target = p.expanded
        ? shape
        : { ...shape, height: Math.min(shape.height, 36) };
      await bounded(
        this.deps.setShape(
          {
            phase: "envelope",
            width: Math.max(from.width, target.width),
            height: Math.max(from.height, target.height),
            visible: !p.hidden,
            audio: this.deps.audio(),
          },
          abort.signal
        )
      );
      if (!current()) return;
      this.deps.commit(p, target);
      await bounded(this.deps.navigate(p));
      if (!current()) return;
      await bounded(this.deps.settle(from, target, abort.signal));
      if (!current()) return;
      await bounded(
        this.deps.setShape(
          {
            phase: "final",
            ...target,
            visible: !p.hidden,
            audio: this.deps.audio(),
          },
          abort.signal
        )
      );
      if (!current()) return;
      this.#current = p;
      if (next && held.has(next.sessionId)) {
        const timer = setTimeout(() => abort.abort(), 8000);
        void bounded(this.deps.load(next.sessionId, abort.signal))
          .catch(() => {
            if (gen === this.#gen) {
              this.deps.retire(next.sessionId);
              this.#held.delete(next.sessionId);
            }
          })
          .finally(() => clearTimeout(timer));
      }
    } catch (error) {
      if (gen !== this.#gen) return;
      for (const id of this.#held) {
        this.deps.retire(id);
        this.#unavailable.set(id, Date.now() + 30_000);
      }
      this.#held.clear();
      const compact = { ...shape, height: 32 };
      const fallback = { ...p, expanded: false };
      this.#current = fallback;
      this.deps.commit(fallback, compact);
      // Recovery must finish even when native shape IPC itself is stalled.
      void this.deps
        .setShape({
          phase: "final",
          ...compact,
          visible: !p.hidden,
          audio: this.deps.audio(),
        })
        .catch(() => undefined);
      if (!timedOut) throw error;
    } finally {
      clearTimeout(deadline);
    }
  }
  dispose(): void {
    ++this.#gen;
    this.#queued = null;
    this.#latest = null;
    this.#abort?.abort();
    for (const id of this.#held) this.deps.retire(id);
    this.#held.clear();
  }
}
