/** The browser build's Appearance: no window material, files from this computer. */
import { THEME_FILE_MAX_BYTES } from "@abacus-ai/contract/look";
import { screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { pickThemeFile, WINDOW_TRANSLUCENCY } from "#platform/appearance";
import { renderApp } from "#renderer/test-support/app-harness";

import { settingsIndexFor } from "./search-index";

afterEach(() => vi.restoreAllMocks());

it("hides translucency and density, keeps the gallery and import", async () => {
  expect(WINDOW_TRANSLUCENCY).toBe(false);
  const app = await renderApp("/settings/appearance");
  try {
    expect(await screen.findByRole("radio", { name: "Paper" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: enUS.settings.appearance.openFile })
    ).toBeDefined();
    expect(
      screen.queryByRole("switch", {
        name: enUS.settings.appearance.translucency,
      })
    ).toBeNull();
    expect(document.querySelector('[data-setting-id="density"]')).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
  const ids = settingsIndexFor(false, "mac").map((entry) => entry.id);
  expect(ids).toContain("importTheme");
  expect(ids).not.toContain("translucency");
});

it("reads a theme file through a transient file input", async () => {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(
    function (this: HTMLInputElement) {
      expect(this.type).toBe("file");
      Object.defineProperty(this, "files", {
        value: [new File(['{"colors": {}}'], "night.json")],
      });
      this.dispatchEvent(new Event("change"));
    }
  );
  await expect(pickThemeFile({} as never)).resolves.toEqual({
    name: "night.json",
    text: '{"colors": {}}',
    size: 14,
  });
});

it("does not read a file over the size cap", async () => {
  const huge = new File(["x"], "huge.json");
  Object.defineProperty(huge, "size", { value: THEME_FILE_MAX_BYTES + 1 });
  const read = vi.spyOn(huge, "text");
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(
    function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", { value: [huge] });
      this.dispatchEvent(new Event("change"));
    }
  );
  await expect(pickThemeFile({} as never)).resolves.toEqual({
    name: "huge.json",
    text: "",
    size: THEME_FILE_MAX_BYTES + 1,
  });
  expect(read).not.toHaveBeenCalled();
});

it("resolves null when the picker is dismissed", async () => {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(
    function (this: HTMLInputElement) {
      this.dispatchEvent(new Event("cancel"));
    }
  );
  await expect(pickThemeFile({} as never)).resolves.toBeNull();
});
