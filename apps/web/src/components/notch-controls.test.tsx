import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { ArrowUp } from "lucide-react";
import { expect, it, vi } from "vitest";

import { notch, springs } from "#renderer/lib/motion";

import { NotchAction, NotchReducedMotion, useNotchMotion } from "./controls";

it("icon actions retain their translated name, tooltip, and button semantics", () => {
  const click = vi.fn();
  render(
    <NotchAction label="Send" onClick={click}>
      <ArrowUp aria-hidden />
    </NotchAction>
  );
  const button = screen.getByRole("button", { name: "Send" });
  expect(button.title).toBe("Send");
  expect(button.textContent).toBe("");
  expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  fireEvent.click(button);
  expect(click).toHaveBeenCalledOnce();
});

it("internal position projection shares the shell/composer spring and cuts under reduced motion", () => {
  let reduced = false;
  const { result, rerender } = renderHook(useNotchMotion, {
    wrapper: ({ children }) => (
      <NotchReducedMotion value={reduced}>{children}</NotchReducedMotion>
    ),
  });
  expect(result.current.layout).toBe("position");
  expect(result.current.transition.layout).toBe(notch.surfaceSpring);
  expect(notch.surfaceSpring.bounce).toBe(springs.surface.bounce);
  expect(notch.surfaceSpring.type).toBe(springs.surface.type);
  reduced = true;
  rerender();
  expect(result.current.layout).toBe(false);
  expect(result.current.transition.layout).toEqual({ duration: 0 });
  expect(result.current.transition.opacity).toEqual({ duration: 0 });
});
