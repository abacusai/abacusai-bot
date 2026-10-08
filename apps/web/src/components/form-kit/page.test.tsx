import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";

import { Button } from "#renderer/ui/button";

import { AreaPage, GroupCard, SettingRow } from "./page";

it("keeps one named page heading and reachable actions in the shared toolbar", () => {
  const view = render(
    <AreaPage
      title="Providers"
      description="Choose where requests go."
      actions={<Button>Add provider</Button>}
    >
      <GroupCard title="Connected">
        <SettingRow
          id="sample"
          title="Sample provider"
          detail="Available for this workspace."
        >
          <Button aria-labelledby="sample-label">Configure</Button>
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Connected" }).tagName).toBe("H2");
  const toolbar = view.container.querySelector('[data-slot="page-toolbar"]')!;
  expect(
    within(toolbar as HTMLElement).getByRole("button", { name: "Add provider" })
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sample provider" })).toBeTruthy();
  expect(screen.getByText("Available for this workspace.").id).toBe(
    "sample-detail"
  );
});
