import { describe, expect, it } from "vitest";

import {
  defaultWorkspaceSearch,
  parseCapabilitiesTab,
  parseWorkspaceSearch,
} from "./route-search";

describe("parseWorkspaceSearch", () => {
  it("accepts known route state", () => {
    expect(
      parseWorkspaceSearch({
        view: "capabilities",
        panel: "preview",
        capabilities: "mcp",
        // An old bookmark still carries the removed diff pane's view mode.
        diff: "split",
      })
    ).toEqual({
      view: "capabilities",
      panel: "preview",
      capabilities: "mcp",
    });
  });

  it("normalizes unknown URL input", () => {
    expect(
      parseWorkspaceSearch({
        view: "missing",
        panel: ["preview"],
        capabilities: null,
        diff: "side-by-side",
      })
    ).toEqual({
      view: "chat",
      capabilities: "connectors",
    });
  });

  it("drops the removed diff pane's tab from an old URL", () => {
    expect(parseWorkspaceSearch({ panel: "changes" })).toEqual({
      view: "chat",
      capabilities: "connectors",
    });
  });

  it("normalizes legacy capabilities search state", () => {
    expect(parseCapabilitiesTab("mcp")).toBe("mcp");
    expect(parseCapabilitiesTab("not-a-tab")).toBe("connectors");
    expect(parseCapabilitiesTab(undefined)).toBe("connectors");
  });

  it("exposes the canonical coding-route fallback search", () => {
    expect(defaultWorkspaceSearch).toEqual({
      view: "chat",
      capabilities: "connectors",
    });
  });
});
