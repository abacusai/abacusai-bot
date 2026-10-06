/**
 * "Never two view transitions in one commit" (spec 01 §6.7 amendment, §13):
 * a React `<ViewTransition>` that animated while the router's document
 * transition is committing would start a second `document.startViewTransition`
 * inside the first one's update, which skips the first. The dev and
 * acceptance builds wrap `startViewTransition` and count a start that
 * happens while another transition's update callback is still running; a
 * new navigation that interrupts a finished commit's animation is normal
 * and not counted. R1-T11b reads the count in the real renderer.
 */
type StartViewTransition = Document["startViewTransition"];

const GUARDED = Symbol.for("abacus.singleViewTransition");

export interface OverlapReport {
  /** Transitions started inside another transition's update (one commit). */
  overlaps: number;
}

type Guarded = Document & {
  [GUARDED]?: OverlapReport;
};

export const guardSingleViewTransition = (
  doc: Document,
  onOverlap: (message: string) => void = (message) => console.error(message)
): OverlapReport | null => {
  const target = doc as Guarded;
  if (target[GUARDED] != null) return target[GUARDED];
  if (typeof doc.startViewTransition !== "function") return null;
  const original = doc.startViewTransition.bind(doc) as StartViewTransition;
  const report: OverlapReport = { overlaps: 0 };
  let updating = 0;
  doc.startViewTransition = ((arg?: unknown) => {
    if (updating > 0) {
      report.overlaps += 1;
      onOverlap(
        "[renderer] a view transition started inside another one's commit"
      );
    }
    const transition = original(arg as never);
    updating += 1;
    const done = (): void => {
      updating -= 1;
    };
    transition.updateCallbackDone.then(done, done);
    return transition;
  }) as StartViewTransition;
  target[GUARDED] = report;
  (globalThis as { __abacusVtOverlaps?: OverlapReport }).__abacusVtOverlaps =
    report;
  return report;
};

/**
 * TanStack/router#7906: `router.startViewTransition` calls
 * `document.startViewTransition` and discards the returned object, so when
 * the browser skips a transition it already started (the window went hidden
 * mid-flight, a second transition pre-empted it, a snapshot timed out) the
 * `ready` / `finished` promises reject with nobody listening: an unhandled
 * rejection per interrupted navigation. This wrapper attaches a handler to
 * both that drops only a skip (a `DOMException` the spec names `AbortError`,
 * `InvalidStateError` or `TimeoutError`) and rethrows anything else, so an
 * update callback that throws still surfaces (through `updateCallbackDone`,
 * which it leaves alone). Composes with `guardSingleViewTransition`: both
 * wrap and forward the same object.
 */
const SETTLED = Symbol.for("abacus.settledViewTransition");

const SKIP_NAMES = new Set(["AbortError", "InvalidStateError", "TimeoutError"]);

/** A rejection that only means the browser skipped the transition. */
export const isSkippedTransition = (error: unknown): boolean =>
  typeof error === "object" &&
  error != null &&
  "name" in error &&
  SKIP_NAMES.has(String((error as { name: unknown }).name));

export const settleSkippedViewTransitions = (doc: Document): boolean => {
  const target = doc as Document & { [SETTLED]?: true };
  if (target[SETTLED]) return true;
  if (typeof doc.startViewTransition !== "function") return false;
  const original = doc.startViewTransition.bind(doc) as StartViewTransition;
  const onReject = (error: unknown): void => {
    if (!isSkippedTransition(error)) throw error;
  };
  doc.startViewTransition = ((arg?: unknown) => {
    const transition = original(arg as never);
    transition.ready.catch(onReject);
    transition.finished.catch(onReject);
    return transition;
  }) as StartViewTransition;
  target[SETTLED] = true;
  return true;
};
