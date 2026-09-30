/**
 * "Never two view transitions in one commit" (spec 01 §6.7 amendment, §13):
 * a React `<ViewTransition>` that animated while the router's document
 * transition runs would start a second `document.startViewTransition`, which
 * skips the first. Dev builds wrap `startViewTransition` and report an
 * overlap; R1-T11b reads the count in the real renderer.
 */
type StartViewTransition = Document["startViewTransition"];

const GUARDED = Symbol.for("abacus.singleViewTransition");

export interface OverlapReport {
  /** Transitions started while another was still running. */
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
  let running = 0;
  doc.startViewTransition = ((arg?: unknown) => {
    if (running > 0) {
      report.overlaps += 1;
      onOverlap(
        "[renderer-next] a second view transition started while one was running"
      );
    }
    const transition = original(arg as never);
    running += 1;
    const done = (): void => {
      running -= 1;
    };
    transition.finished.then(done, done);
    return transition;
  }) as StartViewTransition;
  target[GUARDED] = report;
  (globalThis as { __abacusVtOverlaps?: OverlapReport }).__abacusVtOverlaps =
    report;
  return report;
};
