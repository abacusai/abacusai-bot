import { render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { expect, it } from "vitest";

import { TitleBarGroup, TitleBarIconButton, TitleBarSpacer } from ".";

it("uses one control geometry and exposes its pressed state", () => {
  render(
    <TitleBarGroup>
      <TitleBarSpacer />
      <TitleBarIconButton label="Add" aria-pressed>
        <Plus />
      </TitleBarIconButton>
    </TitleBarGroup>
  );
  const button = screen.getByRole("button", { name: "Add" });
  expect(button.className).toContain("titlebar-icon-button");
  expect(button.className).toContain("titlebar-nodrag");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.parentElement?.className).toContain("titlebar-group");
});
