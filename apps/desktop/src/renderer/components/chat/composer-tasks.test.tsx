import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TodoState } from "../../conversation";
import { ComposerTasksBadge, ComposerTasksDrawer } from "./composer-tasks";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      if (key === "workspace.composerTasks.title") return "Tasks";
      if (key === "workspace.composerTasks.dismiss")
        return "Dismiss tasks for this turn";
      if (key === "workspace.composerTasks.now") return "now";
      if (key === "workspace.composerTasks.progressLabel") {
        return `Tasks: ${values?.completed} of ${values?.total} complete. Current task: ${values?.current}`;
      }
      return key;
    },
  }),
}));

const todos: TodoState = {
  todos: [
    { id: "audit", content: "Audit primitives", status: "completed" },
    { id: "implement", content: "Implement task UI", status: "in_progress" },
    { id: "verify", content: "Verify interactions", status: "pending" },
  ],
  completed: 1,
  inProgress: 1,
  pending: 1,
  total: 3,
};

describe("composer tasks", () => {
  it("renders the active task and segmented progress in the shoulder badge", () => {
    const onToggle = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(
      <ComposerTasksBadge
        todos={todos}
        expanded={false}
        onToggle={onToggle}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Tasks: 1 of 3 complete. Current task: Implement task UI",
      })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss tasks for this turn" })
    );

    expect(screen.getByText("Implement task UI")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(container.querySelectorAll("[aria-hidden] span")).toHaveLength(3);
    expect(
      container.querySelector('[data-composer-tasks-badge="true"]')?.className
    ).toContain("right-4 left-4");
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("renders completed, live, and pending rows in the attached drawer", () => {
    const { container } = render(
      <ComposerTasksDrawer
        todos={todos}
        expanded
        onToggle={() => {}}
        onDismiss={() => {}}
      />
    );

    expect(screen.getByText("✓")).toBeTruthy();
    expect(screen.getByText("●")).toBeTruthy();
    expect(screen.getByText("○")).toBeTruthy();
    expect(screen.getByText("now")).toBeTruthy();
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(3);
    expect(
      container.querySelector('[data-chat-composer-tasks-drawer="true"]')
        ?.className
    ).toContain("w-[calc(100%-2rem)]");
  });
});
