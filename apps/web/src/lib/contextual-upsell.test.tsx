import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  useHasContextualUpsell,
  useVisibleContextualUpsell,
} from "./contextual-upsell";
afterEach(() => vi.unstubAllGlobals());
it("offscreen historical notices leave the general promotion available and release it on unmount", () => {
  let notify: IntersectionObserverCallback = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  const Probe = ({ eligible }: { eligible: boolean }) => {
    const ref = useVisibleContextualUpsell(eligible);
    return <div ref={ref}>Historical notice</div>;
  };
  const Status = () => <output>{String(useHasContextualUpsell())}</output>;
  const tree = (eligible: boolean) => (
    <>
      <Probe eligible={eligible} />
      <Status />
    </>
  );
  const view = render(tree(true));
  const visible = (isIntersecting: boolean) =>
    act(() =>
      notify(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    );
  expect(screen.getByRole("status").textContent).toBe("false");
  visible(true);
  expect(screen.getByRole("status").textContent).toBe("true");
  visible(false);
  expect(screen.getByRole("status").textContent).toBe("false");
  visible(true);
  view.rerender(tree(false));
  expect(screen.getByRole("status").textContent).toBe("false");
  visible(false);
  view.rerender(tree(true));
  expect(screen.getByRole("status").textContent).toBe("false");
  visible(true);
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
  render(<Status />);
  expect(screen.getByRole("status").textContent).toBe("false");
});
