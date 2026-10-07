import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";

import {
  openPanelTab,
  resetPanelStore,
  setPanelOpen,
  activatePanelTab,
} from "./panel-store";
import { SidePanelContent, SidePanelOutlet } from "./side-panel-slot";
import { PanelScopeContext } from "./use-panel";

it("hides inactive bot contents and preserves their state through switching and outlet replacement", () => {
  resetPanelStore();
  const key = "bots:slot-test";
  const details = openPanelTab(key, { kind: "details" });
  const memory = openPanelTab(key, { kind: "memory" });
  const Counter = () => {
    const [value, setValue] = useState(0);
    return <button onClick={() => setValue(value + 1)}>Count {value}</button>;
  };
  const Content = ({ outlet }: { outlet: boolean }) => (
    <PanelScopeContext value={key}>
      <SidePanelContent kind="details">
        <Counter />
      </SidePanelContent>
      <SidePanelContent kind="memory">
        <div>Memory content</div>
      </SidePanelContent>
      {outlet ? <SidePanelOutlet /> : null}
    </PanelScopeContext>
  );
  const view = render(<Content outlet />);
  expect(screen.queryByRole("button", { name: "Count 0" })).toBeNull();
  act(() => activatePanelTab(key, details));
  fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
  act(() => activatePanelTab(key, memory));
  expect(screen.queryByRole("button", { name: "Count 1" })).toBeNull();
  act(() => activatePanelTab(key, details));
  expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
  act(() => setPanelOpen(key, false));
  view.rerender(<Content outlet={false} />);
  view.rerender(<Content outlet />);
  act(() => setPanelOpen(key, true));
  expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
  view.unmount();
});
