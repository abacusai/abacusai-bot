import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

import { FlowPage, FlowHeader } from "./flow-page";

it("keeps the standalone heading, named fields and actions in reading order", () => {
  render(
    <FlowPage
      aria-label="Connect account"
      media={<span aria-hidden>Mark</span>}
    >
      <FlowHeader title="Connect" description="Enter the account number." />
      <label htmlFor="number">Number</label>
      <Input id="number" type="tel" />
      <Button>Continue</Button>
      <Button variant="ghost">Skip</Button>
    </FlowPage>
  );
  const page = screen.getByRole("main", { name: "Connect account" });
  expect(within(page).getAllByRole("heading", { level: 1 })).toHaveLength(1);
  const field = within(page).getByRole("textbox", { name: "Number" });
  const actions = within(page).getAllByRole("button");
  expect(actions.map((action) => action.textContent)).toEqual([
    "Continue",
    "Skip",
  ]);
  expect(
    field.compareDocumentPosition(actions[0]!) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
});
