import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TabsRailPlacementProvider } from "#renderer/components/tabs-rail/placement";

import { SidePanelDrawer } from "./side-panel";

vi.mock("#renderer/data/db/prefs", () => ({
  usePrefs: () => ({ motion: { reduce: true }, appearance: {} }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./side-panel-slot", () => ({
  useSidePanelFilled: () => true,
  SidePanelOutlet: () => <div>Panel content</div>,
}));

describe("floating panel rail", () => {
  it.each(["titlebar", "panel"] as const)("has one owner: %s", (placement) => {
    const close = vi.fn();
    render(
      <TabsRailPlacementProvider placement={placement} reportWidth={() => {}}>
        <button>Title-bar control</button>
        <SidePanelDrawer
          open
          tabs={[{ id: "details", kind: "details" }]}
          active={{ id: "details", kind: "details" }}
          kinds={["files"]}
          onAdd={vi.fn()}
          onTabChange={vi.fn()}
          onTabClose={vi.fn()}
          onTabReorder={vi.fn()}
          onReopen={vi.fn()}
          onClose={close}
        />
      </TabsRailPlacementProvider>
    );
    expect(
      document.querySelectorAll(
        '[data-side-panel] [data-slot="topbar-panel-tabs"]'
      ).length
    ).toBe(placement === "panel" ? 1 : 0);
    fireEvent.click(screen.getByText("Title-bar control"));
    expect(close).not.toHaveBeenCalled();
  });
});
