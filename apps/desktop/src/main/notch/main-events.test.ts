import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { expect, it, vi } from "vitest";

import { wireMainNotchEvents } from "./main-events";
it("publishes app changes from the main window's real event registrations", () => {
  const window = new EventEmitter();
  const changed = vi.fn();
  wireMainNotchEvents(window, changed);
  for (const event of ["focus", "blur", "show", "hide", "closed"]) {
    window.emit(event);
    expect(changed).toHaveBeenCalledTimes(
      ["focus", "blur", "show", "hide", "closed"].indexOf(event) + 1
    );
  }
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(entry).toContain(
    "wireMainNotchEvents(mainWindow, () => notchController?.appChanged())"
  );
});
