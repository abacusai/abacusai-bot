import { expect, it, vi } from "vitest";

import { terminalKeyHandler } from "./keys";
it("R4-T39 Windows control and printable keys reach the shell while dock chords are handled", () => {
  const dispatch = vi.fn();
  const term = {
    hasSelection: () => false,
    getSelection: () => "",
    paste: vi.fn(),
    scrollPages: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  const handler = terminalKeyHandler("windows", dispatch, term);
  for (const key of ["a", "8", " ", ";", "c", "r", "w"]) {
    expect(
      handler(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey: ["c", "r", "w"].includes(key),
        })
      )
    ).toBe(false);
  }
  expect(
    handler(
      new KeyboardEvent("keydown", { key: "w", ctrlKey: true, shiftKey: true })
    )
  ).toBe(true);
  expect(dispatch).toHaveBeenCalledWith("closeTab");
  expect(
    handler(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }))
  ).toBe(true);
  expect(dispatch).toHaveBeenCalledWith("nextTab");
});
