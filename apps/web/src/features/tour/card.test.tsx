import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { TourCard } from "./card";
import { TOUR_STOPS } from "./stops";

beforeAll(() => initI18n());
const card = (index = 0) => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const onDismiss = vi.fn();
  const onNext = vi.fn();
  const view = render(
    <TourCard
      anchor={anchor}
      stop={TOUR_STOPS[index]!}
      index={index}
      onDismiss={onDismiss}
      onNext={onNext}
    />
  );
  return { ...view, anchor, onDismiss, onNext };
};
it("advances without trapping focus or adding an overlay", async () => {
  const view = card();
  await screen.findByText("Sessions");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(view.onNext).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-slot="popover-backdrop"]')).toBeNull();
  view.anchor.focus();
  expect(document.activeElement).toBe(view.anchor);
  view.anchor.remove();
});
it.each(["escape", "close", "outside"] as const)(
  "dismisses the whole tour on %s",
  async (method) => {
    const view = card();
    await screen.findByText("Sessions");
    if (method === "escape") fireEvent.keyDown(document, { key: "Escape" });
    if (method === "close")
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    if (method === "outside") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      fireEvent.mouseDown(document.body);
      fireEvent.click(document.body);
    }
    await waitFor(() => expect(view.onDismiss).toHaveBeenCalled());
    view.anchor.remove();
  }
);
it("finishes after four stops", async () => {
  const view = card(3);
  fireEvent.click(await screen.findByRole("button", { name: "Start working" }));
  expect(view.onNext).toHaveBeenCalledOnce();
  view.anchor.remove();
});
