import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { PendingSteers } = await import("./pending-steers");

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

describe("messages on their way to the model", () => {
  it("renders nothing with an empty queue, and hides hidden entries", () => {
    const { container } = render(
      <PendingSteers
        entries={[{ id: "a", message: "internal", hidden: true }]}
        onEdit={() => {}}
        onRemove={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("says what each message is waiting on, and lets it be withdrawn", () => {
    const onRemove = vi.fn();
    render(
      <PendingSteers
        entries={[
          { id: "a", message: "shorter please", waitingFor: "step" },
          { id: "b", message: "then list it", waitingFor: "permission" },
        ]}
        onEdit={() => {}}
        onRemove={onRemove}
      />
    );

    const labels = [
      ...document.querySelectorAll('[data-id="pending-steer-label"]'),
    ].map((node) => node.textContent);
    expect(labels).toEqual([
      "workspace.pendingSteer.step",
      "workspace.pendingSteer.permission",
    ]);

    fireEvent.click(
      byId("pending-steer-b")!.querySelector(
        '[data-id="pending-steer-remove"]'
      )!
    );
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("edits in place and commits on Enter", () => {
    const onEdit = vi.fn();
    render(
      <PendingSteers
        entries={[{ id: "a", message: "shorter please", waitingFor: "step" }]}
        onEdit={onEdit}
        onRemove={() => {}}
      />
    );

    fireEvent.click(byId("pending-steer-edit")!);
    const editor = byId("pending-steer-editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "much shorter please" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledWith("a", "much shorter please");
    expect(byId("pending-steer-editor")).toBeNull();
  });
});
