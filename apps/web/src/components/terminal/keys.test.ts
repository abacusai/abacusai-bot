import { expect, it, vi } from "vitest";

import { resolveKeymap } from "#renderer/lib/keyboard/actions";

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

it("uses terminal overrides and unbindings instead of the old fixed dock chords", () => {
  const dispatch = vi.fn();
  const term = {
    hasSelection: () => false,
    getSelection: () => "",
    paste: vi.fn(),
    scrollPages: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  const keymap = resolveKeymap(
    { "close-tab@terminal": "Ctrl+Shift+E", "next-tab": null },
    "windows"
  );
  const handler = terminalKeyHandler(
    "windows",
    dispatch,
    term,
    keymap.terminal
  );
  expect(
    handler(
      new KeyboardEvent("keydown", { key: "w", ctrlKey: true, shiftKey: true })
    )
  ).toBe(false);
  expect(
    handler(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }))
  ).toBe(false);
  expect(
    handler(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }))
  ).toBe(false);
  expect(
    handler(
      new KeyboardEvent("keydown", { key: "e", ctrlKey: true, shiftKey: true })
    )
  ).toBe(true);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("closeTab");
  expect(
    handler(new KeyboardEvent("keydown", { key: "`", ctrlKey: true }))
  ).toBe(true);
  expect(dispatch).toHaveBeenLastCalledWith("newTerminalTab");
  expect(
    handler(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))
  ).toBe(true);
  expect(dispatch).toHaveBeenLastCalledWith("command");
});
