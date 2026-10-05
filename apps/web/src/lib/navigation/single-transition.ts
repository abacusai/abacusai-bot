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
