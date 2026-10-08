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

it("keeps flow consumers on shared controls and theme tokens", async () => {
  const sources = await Promise.all([
    import("#renderer/features/shell/connect/index.tsx?raw"),
    import("#renderer/features/onboarding/whatsapp.tsx?raw"),
    import("#renderer/features/routines/reach-panel.tsx?raw"),
    import("#renderer/features/routines/hosted-results.tsx?raw"),
  ]);
  for (const { default: source } of sources) {
    expect(source).not.toMatch(/<button\b/);
    expect(source).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(source).not.toMatch(/rounded-\[\d/);
    expect(source).not.toMatch(/<div\b[^>]*role="dialog"/s);
  }
});
