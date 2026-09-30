/**
 * `navigateAndSettle(href)` for the screenshot run (spec 01 §10.2, R1-T21).
 * Resolves only after: the router resolved *that* href with nothing pending;
 * the active view transition finished; every finite animation finished
 * (Spinner/Skeleton loop forever, so infinite ones are excluded); fonts are
 * ready; no collection is still loading; two animation frames. Infinite
 * animations are then frozen at a deterministic phase (`currentTime = 0`).
 */
import type { AnyRouter } from "@tanstack/react-router";

export interface SettleDeps {
  router: Pick<AnyRouter, "navigate" | "subscribe" | "state">;
  doc?: Document;
  collections?: Array<{
    status: string;
    on(event: "status:change", cb: () => void): () => void;
  }>;
  frame?: (callback: () => void) => void;
  timeoutMs?: number;
}

const isInfinite = (animation: Animation): boolean =>
  animation.effect?.getComputedTiming().endTime === Infinity;

const nextFrames = (frame: (callback: () => void) => void, count: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number): void => {
      if (left === 0) resolve();
      else frame(() => step(left - 1));
    };
    step(count);
  });

const collectionsSettled = (
  collections: NonNullable<SettleDeps["collections"]>
): Promise<void> =>
  Promise.all(
    collections.map(
      (collection) =>
        new Promise<void>((resolve) => {
          const done = (): boolean =>
            collection.status !== "loading" && collection.status !== "idle";
          if (collection.status === "idle" || done()) {
            resolve();
            return;
          }
          const off = collection.on("status:change", () => {
            if (!done()) return;
            off();
            resolve();
          });
        })
    )
  ).then(() => undefined);

/** Wait for finite animations; freeze infinite ones at their start. */
export const settleAnimations = async (doc: Document): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    const finite = doc
      .getAnimations()
      .filter((animation) => !isInfinite(animation));
    const running = finite.filter(
      (animation) => animation.playState === "running"
    );
    if (running.length === 0) break;
    await Promise.all(
      running.map((animation) => animation.finished.catch(() => undefined))
    );
  }
  for (const animation of doc.getAnimations()) {
    if (!isInfinite(animation)) continue;
    animation.pause();
    animation.currentTime = 0;
  }
};

export const navigateAndSettle = async (
  href: string,
  deps: SettleDeps
): Promise<void> => {
  const doc = deps.doc ?? document;
  const frame =
    deps.frame ?? ((callback) => requestAnimationFrame(() => callback()));
  const { router } = deps;

  const resolved = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`navigateAndSettle: ${href} did not resolve`)),
      deps.timeoutMs ?? 15_000
    );
    const off = router.subscribe("onResolved", (event) => {
      if (event.toLocation.href !== href) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    if (router.state.location.href === href && router.state.status === "idle") {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
  void router.navigate({ href } as never);
  await resolved;

  const transition = (
    doc as Document & {
      activeViewTransition?: { finished: Promise<void> } | null;
    }
  ).activeViewTransition;
  if (transition != null) await transition.finished.catch(() => undefined);
  await settleAnimations(doc);
  await doc.fonts?.ready;
  if (deps.collections != null) await collectionsSettled(deps.collections);
  await nextFrames(frame, 2);
  await settleAnimations(doc);
};
