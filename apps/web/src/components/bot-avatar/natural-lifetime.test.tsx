import { render } from "@testing-library/react";
import { useRef } from "react";
import { expect, it, vi } from "vitest";

import { useNaturalMotion } from "./natural";
import { personalityFromIdentity } from "./personality";

const person = personalityFromIdentity("lifetime");
const Rehearsal = ({ active }: { active: boolean }) => {
  const ref = useRef<HTMLSpanElement>(null);
  useNaturalMotion(ref, active, "lifetime", person, "idle", 1, undefined);
  return (
    <span ref={ref}>
      <svg>
        <g className="bav-eye-open" />
        <g className="bav-gaze" />
        <g className="bav-volume" />
      </svg>
    </span>
  );
};
it("cancels native timelines when the visibility lease stops and recreates them on resume", () => {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel, currentTime: 0 }));
  const original = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "animate"
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  try {
    const { rerender, unmount } = render(<Rehearsal active />);
    expect(animate).toHaveBeenCalledTimes(2);
    rerender(<Rehearsal active={false} />);
    expect(cancel).toHaveBeenCalledTimes(2);
    rerender(<Rehearsal active />);
    expect(animate).toHaveBeenCalledTimes(4);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(4);
  } finally {
    if (original) Object.defineProperty(Element.prototype, "animate", original);
    else Reflect.deleteProperty(Element.prototype, "animate");
  }
});
