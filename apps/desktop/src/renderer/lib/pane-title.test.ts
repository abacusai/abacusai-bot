import { describe, expect, it } from "vitest";

import { selectPaneTitleKey } from "./pane-title";

const match = (
  staticData: { titleKey?: unknown },
  params: Record<string, string> = {}
) =>
  ({ staticData, params }) as unknown as Parameters<
    typeof selectPaneTitleKey
  >[0][number];

describe("selectPaneTitleKey", () => {
  it("leaves the chat route without a title of its own", () => {
    // The title bar falls back to the session label only here — anywhere else
    // that label would describe a chat the pane is not showing.
    expect(selectPaneTitleKey([match({}), match({})])).toBeUndefined();
  });

  it("names the pane destination that is showing", () => {
    expect(
      selectPaneTitleKey([
        match({}),
        match({ titleKey: "sidebarNav.messaging" }),
      ])
    ).toBe("sidebarNav.messaging");
  });

  it("prefers the deepest match, so a toolset names itself", () => {
    expect(
      selectPaneTitleKey([
        match({ titleKey: "capabilities.tabs.tools" }),
        match(
          {
            titleKey: (params: Record<string, string>) =>
              `capabilities.toolsets.${params.toolsetId}.label`,
          },
          { toolsetId: "terminal" }
        ),
      ])
    ).toBe("capabilities.toolsets.terminal.label");
  });

  it("falls back past a detail route that cannot name itself", () => {
    expect(
      selectPaneTitleKey([
        match({ titleKey: "capabilities.tabs.tools" }),
        match({ titleKey: () => undefined }),
      ])
    ).toBe("capabilities.tabs.tools");
  });
});
