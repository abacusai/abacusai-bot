import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { Spotlight } from "./index";

it("R6-T12 makes the shell inert, traps focus, ignores overlay clicks and restores focus", () => {
  const prior = document.createElement("button");
  document.body.append(prior);
  prior.focus();
  const dismiss = vi.fn();
  const { getByRole, unmount, baseElement } = render(
    <Spotlight
      rect={null}
      onDismiss={dismiss}
      titleId="tour-title"
      bodyId="tour-body"
    >
      <h2 id="tour-title">Tour</h2>
      <p id="tour-body">Try the app</p>
      <button>Back</button>
      <button data-tour-next>Next</button>
    </Spotlight>
  );
  expect(prior.inert).toBe(true);
  expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
  expect(getByRole("dialog").getAttribute("aria-modal")).toBe("true");
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(getByRole("button", { name: "Back" }));
  fireEvent.click(baseElement.querySelector('[data-slot="tour-spotlight"]')!);
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(dismiss).toHaveBeenCalledOnce();
  unmount();
  expect(prior.inert).not.toBe(true);
  expect(document.activeElement).toBe(prior);
  prior.remove();
});
