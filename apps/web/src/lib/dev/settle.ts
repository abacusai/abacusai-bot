/**
 * `navigateAndSettle(href)` for the screenshot run (spec 01 §10.2, R1-T21).
 * Resolves only after: the router resolved *that* href with nothing pending;
 * the active view transition finished; every finite animation finished
 * (Spinner/Skeleton loop forever, so infinite ones are excluded); fonts are
 * ready; no collection is still loading; two animation frames. Infinite
 * animations are then frozen at a deterministic phase (`currentTime = 0`).
 *
 * Scroll-driven animations (a `ScrollTimeline`/`ViewTimeline`, e.g. the
 * registry's `scroll-fade-*` utilities) are neither waited for nor frozen:
 * they advance with scrolling, not time, so "finished" never comes. Frames
 * are bounded by a timer, because Chromium does not run
 * `requestAnimationFrame` in a hidden or occluded window.
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
  /** Longest wait for one frame before a timer stands in (occluded window). */
  frameFallbackMs?: number;
}

const FRAME_FALLBACK_MS = 100;

const isInfinite = (animation: Animation): boolean =>
  animation.effect?.getComputedTiming().endTime === Infinity;

/**
 * Driven by a scroll or view timeline rather than the document's clock.
 * Checked structurally (a `source` or `subject`, or the constructor name),
 * since jsdom and older engines have no `ScrollTimeline` global.
 */
const isScrollDriven = (animation: Animation, doc: Document): boolean => {
  const timeline = animation.timeline as
    | (AnimationTimeline & { source?: unknown; subject?: unknown })
    | null
    | undefined;
  if (timeline == null) return false;
  if (timeline === doc.timeline) return false;
  const name = (timeline as { constructor?: { name?: string } }).constructor
    ?.name;
  return (
    name === "ScrollTimeline" ||
    name === "ViewTimeline" ||
    "source" in timeline ||
    "subject" in timeline
  );
};

/** One frame, or the fallback timer when frames are not being produced. */
const oneFrame = (
  frame: (callback: () => void) => void,
  doc: Document,
  fallbackMs: number
): Promise<void> =>
  new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      finish,
      doc.visibilityState === "hidden" ? 0 : fallbackMs
    );
    frame(finish);
  });

const nextFrames = async (
  frame: (callback: () => void) => void,
  doc: Document,
  count: number,
  fallbackMs: number
): Promise<void> => {
  for (let left = count; left > 0; left -= 1)
    await oneFrame(frame, doc, fallbackMs);
};

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
const settleAnimations = async (
  doc: Document,
  frame: (callback: () => void) => void,
  fallbackMs: number,
  timeoutMs: number
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const finite = doc
      .getAnimations()
      .filter(
        (animation) => !isInfinite(animation) && !isScrollDriven(animation, doc)
      );
    const running = finite.filter(
      (animation) => animation.playState === "running"
    );
    if (running.length === 0) break;
    if (Date.now() >= deadline)
      throw new Error("navigateAndSettle: finite animations did not settle");
    // Chromium can leave `finished` pending after an offscreen animation
    // reaches its end. Re-read active animations as their timelines change.
    await oneFrame(frame, doc, fallbackMs);
  }
  for (const animation of doc.getAnimations()) {
    if (!isInfinite(animation) || isScrollDriven(animation, doc)) continue;
    animation.pause();
    animation.currentTime = 0;
  }
};

/**
 * Whether a resolved location is the one `href` asked for: same path, and
 * every search param given (defaults the route adds may be extra).
 */
const isLocationFor = (
  href: string,
  location: {
    pathname?: string;
    href: string;
    search?: Record<string, unknown>;
  }
): boolean => {
  const target = new URL(href, "http://x");
  const pathname =
    location.pathname ?? new URL(location.href, "http://x").pathname;
  if (pathname !== target.pathname) return false;
  for (const [key, value] of target.searchParams)
    if (String(location.search?.[key]) !== value) return false;
  return true;
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
      if (!isLocationFor(href, event.toLocation)) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    if (
      isLocationFor(href, router.state.location) &&
      router.state.status === "idle"
    ) {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
  void router.navigate({ href });
  await resolved;

  const transition = (
    doc as Document & {
      activeViewTransition?: { finished: Promise<void> } | null;
    }
  ).activeViewTransition;
  if (transition != null) await transition.finished.catch(() => undefined);
  const fallbackMs = deps.frameFallbackMs ?? FRAME_FALLBACK_MS;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  await settleAnimations(doc, frame, fallbackMs, timeoutMs);
  await doc.fonts?.ready;
  if (deps.collections != null) await collectionsSettled(deps.collections);
  await nextFrames(frame, doc, 2, fallbackMs);
  await settleAnimations(doc, frame, fallbackMs, timeoutMs);
};
