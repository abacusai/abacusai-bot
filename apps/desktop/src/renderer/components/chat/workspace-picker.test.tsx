import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceListItem } from "#shared/contracts";

import { WorkspacePicker } from "./workspace-picker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (key === "workspace.welcome.switchWorkspace") {
        return `Switch workspace from ${values?.workspace}`;
      }
      if (key === "workspace.welcome.addWorkspace") return "Add workspace";
      return key;
    },
  }),
}));

const workspaces: WorkspaceListItem[] = [
  {
    id: "one",
    label: "one",
    description: "first workspace",
    status: "active",
    path: "/tmp/one",
  },
  {
    id: "two",
    label: "two",
    description: "second workspace",
    status: "idle",
    path: "/tmp/two",
  },
];

describe("WorkspacePicker", () => {
  it("opens from the heading control and switches through the typed callback", async () => {
    const onSwitchWorkspace = vi.fn();
    render(
      <WorkspacePicker
        workspaces={workspaces}
        activeWorkspaceId="one"
        onSwitchWorkspace={onSwitchWorkspace}
        onAddWorkspace={() => {}}
      />
    );

    const trigger = screen.getByRole("button", {
      name: "Switch workspace from one",
    });
    expect(trigger.querySelector("span")?.className).toContain(
      "decoration-dotted"
    );
    expect(trigger.className).toContain("text-2xl");
    expect(trigger.className).toContain("@2xl:text-3xl");
    expect(trigger.className).toContain("min-w-0");
    // Character-based, not rem-based: the heading renders at two font sizes,
    // and a fixed rem cap cut the name shorter at the larger one, which is
    // where the folder name was being clipped.
    expect(trigger.className).toContain("max-w-[24ch]");
    expect(trigger.className).not.toContain("max-w-64");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("two"));

    expect(onSwitchWorkspace).toHaveBeenCalledWith("two");
  });

  it("uses the same workspace menu in its compact titlebar presentation", async () => {
    const onSwitchWorkspace = vi.fn();
    render(
      <WorkspacePicker
        workspaces={workspaces}
        activeWorkspaceId="one"
        onSwitchWorkspace={onSwitchWorkspace}
        onAddWorkspace={() => {}}
        variant="titlebar"
      />
    );

    const trigger = screen.getByRole("button", {
      name: "Switch workspace from one",
    });
    expect(trigger.className).toContain("text-xs");
    expect(trigger.className).toContain("max-w-40");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("two"));

    expect(onSwitchWorkspace).toHaveBeenCalledWith("two");
  });
});
