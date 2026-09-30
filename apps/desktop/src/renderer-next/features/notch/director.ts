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
  setShape(shape: NotchShape): Promise<unknown>;
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
  constructor(readonly deps: DirectorDeps) {}
  lock(locked: boolean): void {
    this.#locked = locked;
    if (!locked && this.#queued) {
      const next = this.#queued;
      this.#queued = null;
      void this.present(next.p, next.shape);
    }
  }
  async present(p: NotchPresentation, shape: Shape): Promise<void> {
    const valid =
      this.#current &&
      p.queue.some(
        (item) =>
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
    const gen = ++this.#gen;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const deadline = setTimeout(() => abort.abort(), 8000);
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
            await this.deps.load(p.sessionId, abort.signal);
          } catch {
            if (gen !== this.#gen) return;
            this.#unavailable.set(p.sessionId, Date.now() + 30_000);
            this.deps.retire(p.sessionId);
            held.delete(p.sessionId);
            p = { ...p, expanded: false };
          }
          if (gen !== this.#gen) return;
        }
      }
      if (abort.signal.aborted && gen === this.#gen) {
        // Deadline: retain an actionable compact wing, using a new shape-only generation.
        clearTimeout(deadline);
        this.#abort = null;
        await this.deps.setShape({
          phase: "final",
          ...shape,
          height: 32,
          visible: !p.hidden,
          audio: this.deps.audio(),
        });
        if (gen === this.#gen)
          this.deps.commit({ ...p, expanded: false }, { ...shape, height: 32 });
        return;
      }
      if (!current()) return;
      const from = this.deps.renderedSize();
      const target = p.expanded
        ? shape
        : { ...shape, height: Math.min(shape.height, 36) };
      await this.deps.setShape({
        phase: "envelope",
        width: Math.max(from.width, target.width),
        height: Math.max(from.height, target.height),
        visible: !p.hidden,
        audio: this.deps.audio(),
      });
      if (!current()) return;
      this.deps.commit(p, target);
      await this.deps.navigate(p);
      if (!current()) return;
      await this.deps.settle(from, target, abort.signal);
      if (!current()) return;
      await this.deps.setShape({
        phase: "final",
        ...target,
        visible: !p.hidden,
        audio: this.deps.audio(),
      });
      if (!current()) return;
      this.#current = p;
      if (next && held.has(next.sessionId))
        void this.deps.load(next.sessionId, abort.signal).catch(() => {
          if (gen === this.#gen) {
            this.deps.retire(next.sessionId);
            this.#held.delete(next.sessionId);
          }
        });
    } finally {
      clearTimeout(deadline);
    }
  }
  dispose(): void {
    ++this.#gen;
    this.#abort?.abort();
    for (const id of this.#held) this.deps.retire(id);
    this.#held.clear();
  }
}
