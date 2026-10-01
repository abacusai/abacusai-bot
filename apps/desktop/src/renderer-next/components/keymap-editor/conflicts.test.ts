import { describe, it, expect } from "vitest";

import { bindingConflict } from "./index";
describe("R5-T25 context-specific shortcut conflicts", () => {
  it("checks terminal bindings in their own context", () => {
    expect(
      bindingConflict("close-tab@terminal", "Ctrl+Shift+W", {}, "windows")
    ).toBeNull();
    expect(
      bindingConflict("close-tab@terminal", "Ctrl+W", {}, "windows")
    ).toEqual({ id: "system", rebindable: false });
    expect(bindingConflict("close-tab", "Mod+W", {}, "windows")).toBeNull();
  });
  it("finds rebindable action conflicts and rejects reserved system chords", () => {
    expect(bindingConflict("new-bot", "Mod+K", {}, "mac")).toEqual({
      id: "command-menu",
      rebindable: true,
    });
    expect(bindingConflict("new-bot", "Mod+Q", {}, "mac")).toEqual({
      id: "system",
      rebindable: false,
    });
    expect(
      bindingConflict("new-bot", "Mod+K", { "command-menu": null }, "mac")
    ).toBeNull();
  });
});
it("shared bindings check terminal defaults and terminal reserved keys", () => {
  expect(
    bindingConflict("toggle-side-panel", "Ctrl+Shift+W", {}, "windows")
  ).toEqual({ id: "close-tab@terminal", rebindable: true });
  expect(bindingConflict("toggle-side-panel", "Ctrl+L", {}, "windows")).toEqual(
    { id: "system", rebindable: false }
  );
});
