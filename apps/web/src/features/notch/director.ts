import type { NotchShape } from "@abacus-ai/contract/contract/notch";

import type { NotchPresentation } from "./presenter";
export interface Shape {
  width: number;
  height: number;
  compactHeight?: number;
}
export interface DirectorDeps {
  load(id: string, signal: AbortSignal): Promise<void>;
  retire(id: string): void;
  setShape(shape: NotchShape, signal?: AbortSignal): Promise<unknown>;
  navigate(presentation: NotchPresentation): Promise<void>;
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
            !item.snoozed &&
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
      // The native window already contains every presentation. One report
      // updates visibility/audio; shell motion never waits for native resizing.
      await bounded(
        this.deps.setShape(
          {
            phase: "final",
            ...shape,
            visible: !p.hidden,
            audio: this.deps.audio(),
          },
          abort.signal
        )
      );
      if (!current()) return;
      this.deps.commit(p, shape);
      await bounded(this.deps.navigate(p));
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
      const compact = { ...shape, height: shape.compactHeight ?? 32 };
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
