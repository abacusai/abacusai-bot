import { describe, expect, it } from "vitest";

import { resolveKeymap, bindingIds } from "./actions";
describe("R5-T25 keymap contexts", () => {
  it("keeps null unbound and terminal defaults independent", () => {
    const map = resolveKeymap(
      { "close-tab": "Alt+W", "new-in-area": null },
      "windows"
    );
    expect(map.window["close-tab"]).toBe("Alt+W");
    expect(map.terminal["close-tab"]).toBe("Ctrl+Shift+W");
    expect(map.window["new-in-area"]).toBeNull();
    expect(map.terminal["new-in-area"]).toBeNull();
  });
  it("overrides each context independently", () => {
    expect(
      resolveKeymap({ "close-tab@terminal": null }, "linux").terminal[
        "close-tab"
      ]
    ).toBeNull();
    expect(
      resolveKeymap({ "close-tab": null }, "mac").terminal["close-tab"]
    ).toBeNull();
    expect(bindingIds("mac")).not.toContain("close-tab@terminal");
  });
});
