import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { renderApp, SYSTEM_INFO } from "#next/test-support/app-harness";
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
it("R5-T25 terminal unbind and per-binding reset leave the window shortcut intact", async () => {
  app = await renderApp("/settings/keyboard", {
    system: { ...SYSTEM_INFO, platform: "linux" },
  });
  await waitFor(() =>
    expect(
      document.querySelector('[data-setting-id="key-close-tab@terminal"]')
    ).not.toBeNull()
  );
  const row = document.querySelector<HTMLElement>(
    '[data-setting-id="key-close-tab@terminal"]'
  )!;
  fireEvent.click(within(row).getByRole("button", { name: "Unbind" }));
  await waitFor(() =>
    expect(
      app!.collections.prefs.get("app")?.keymap?.["close-tab@terminal"]
    ).toBeNull()
  );
  expect(
    app.collections.prefs.get("app")?.keymap?.["close-tab"]
  ).toBeUndefined();
  fireEvent.click(within(row).getByRole("button", { name: "Reset" }));
  await waitFor(() =>
    expect(
      Object.hasOwn(
        app!.collections.prefs.get("app")?.keymap ?? {},
        "close-tab@terminal"
      )
    ).toBe(false)
  );
});
it("R5-T25 real recorder records a chord and Escape cancels a second recording", async () => {
  app = await renderApp("/settings/keyboard");
  await screen.findByRole("heading", { name: "Keyboard" });
  const row = document.querySelector<HTMLElement>(
    '[data-setting-id="key-new-bot"]'
  )!;
  fireEvent.click(within(row).getByRole("button", { name: "Change" }));
  fireEvent.keyDown(document.body, {
    key: "l",
    code: "KeyL",
    metaKey: true,
    shiftKey: true,
  });
  await waitFor(() =>
    expect(app!.collections.prefs.get("app")?.keymap?.["new-bot"]).toBe(
      "Mod+Shift+L"
    )
  );
  fireEvent.click(within(row).getByRole("button", { name: "Change" }));
  fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryByText("Press the new shortcut… Esc to cancel")
    ).toBeNull()
  );
  expect(app.collections.prefs.get("app")?.keymap?.["new-bot"]).toBe(
    "Mod+Shift+L"
  );
});
