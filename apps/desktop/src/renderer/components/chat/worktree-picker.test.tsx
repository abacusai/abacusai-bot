import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorktreeListItem } from "#shared/contracts";

import { WorktreePicker } from "./worktree-picker";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "workspace.worktree.select") return "Select worktree";
      if (key === "workspace.worktree.currentCheckout") {
        return "Current checkout";
      }
      if (key === "workspace.worktree.create") return "New worktree";
      return key;
    },
  }),
}));

const worktrees: WorktreeListItem[] = [
  {
    id: "current",
    name: "main",
    path: "/repo",
    branch: "main",
    isCurrent: true,
    isManaged: false,
  },
  {
    id: "feature",
    name: "feature-ui",
    path: "/repo-worktrees/feature-ui",
    branch: "feature-ui",
    isCurrent: false,
    isManaged: true,
  },
];

describe("WorktreePicker", () => {
  it("uses the current checkout and keeps unsupported actions disabled", () => {
    render(
      <WorktreePicker
        worktrees={worktrees}
        activeWorktreeId={null}
        environment={{ kind: "current" }}
        allowNewWorktree={false}
        onSelectEnvironment={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select worktree" }));

    expect(
      screen
        .getByRole("menuitem", { name: "feature-ui" })
        .getAttribute("aria-disabled")
    ).toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "New worktree" })
        .getAttribute("aria-disabled")
    ).toBe("true");
  });

  it("emits selection and staged-new-worktree intent through separate callbacks", () => {
    const onSelectEnvironment = vi.fn();
    render(
      <WorktreePicker
        worktrees={worktrees}
        activeWorktreeId="current"
        environment={{ kind: "current" }}
        allowNewWorktree
        onSelectEnvironment={onSelectEnvironment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Select worktree" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "feature-ui" }));
    expect(onSelectEnvironment).toHaveBeenCalledWith({
      kind: "existing",
      worktreeId: "feature",
    });

    fireEvent.click(screen.getByRole("button", { name: "Select worktree" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New worktree" }));
    expect(onSelectEnvironment).toHaveBeenLastCalledWith({
      kind: "new",
      baseRef: "HEAD",
    });
  });

  it("disables selection while pending and keeps a failed draft visible", () => {
    const { rerender } = render(
      <WorktreePicker
        worktrees={worktrees}
        activeWorktreeId={null}
        environment={{ kind: "new", baseRef: "HEAD" }}
        allowNewWorktree
        isPending
        onSelectEnvironment={() => {}}
      />
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Select worktree",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(screen.getByText("New worktree")).toBeDefined();

    rerender(
      <WorktreePicker
        worktrees={worktrees}
        activeWorktreeId={null}
        environment={{ kind: "new", baseRef: "HEAD" }}
        allowNewWorktree
        error={new Error("worktree preparation failed")}
        onSelectEnvironment={() => {}}
      />
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText("New worktree")).toBeDefined();
  });
});
