import { getHotkeyManager, getSequenceManager } from "@tanstack/react-hotkeys";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  defaultSeed,
  renderApp,
  SYSTEM_INFO,
} from "#next/test-support/app-harness";
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

it("R5-T25 ignores a window binding that is unbound in the terminal context", async () => {
  app = await renderApp("/settings/keyboard", {
    system: { ...SYSTEM_INFO, platform: "linux" },
  });
  await app.appDb.updatePrefs({ keymap: { "new-in-area": "Ctrl+Shift+J" } });
  const handle = getHotkeyManager().register("Mod+Shift+J", () => {}, {
    platform: "linux",
    meta: { actionId: "new-in-area" },
  });
  try {
    const row = document.querySelector<HTMLElement>(
      '[data-setting-id="key-close-tab@terminal"]'
    )!;
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    fireEvent.keyDown(document.body, {
      key: "j",
      code: "KeyJ",
      ctrlKey: true,
      shiftKey: true,
    });
    await waitFor(() =>
      expect(
        app!.collections.prefs.get("app")?.keymap?.["close-tab@terminal"]
      ).toBe("Mod+Shift+J")
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    handle.unregister();
  }
});
it("R5-T25 a live sequence conflict cannot be stolen by Use anyway", async () => {
  app = await renderApp("/settings/keyboard");
  await screen.findByRole("heading", { name: "Keyboard" });
  const handle = getSequenceManager().register(["Mod+Shift+J", "K"], () => {}, {
    platform: "mac",
    meta: { description: "Fixed editor sequence" },
  });
  try {
    const row = document.querySelector<HTMLElement>(
      '[data-setting-id="key-new-bot"]'
    )!;
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    fireEvent.keyDown(document.body, {
      key: "j",
      code: "KeyJ",
      metaKey: true,
      shiftKey: true,
    });
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Use anyway" })).toBeNull();
    expect(
      app.collections.prefs.get("app")?.keymap?.["new-bot"]
    ).toBeUndefined();
  } finally {
    handle.unregister();
  }
});
it("recording a shared action's current chord excludes its own live registration", async () => {
  app = await renderApp("/settings/keyboard");
  await screen.findByRole("heading", { name: "Keyboard" });
  const row = document.querySelector<HTMLElement>(
    '[data-setting-id="key-toggle-side-panel"]'
  )!;
  fireEvent.click(within(row).getByRole("button", { name: "Change" }));
  fireEvent.keyDown(document.body, {
    key: "b",
    code: "KeyB",
    metaKey: true,
    altKey: true,
  });
  await waitFor(() =>
    expect(
      app!.collections.prefs.get("app")?.keymap?.["toggle-side-panel"]
    ).toBe("Mod+Alt+B")
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("Use anyway atomically clears every displaced window and terminal binding", async () => {
  const seed = defaultSeed();
  seed.prefs!.keymap = {
    "new-in-area": "Ctrl+Shift+J",
    "close-tab@terminal": "Ctrl+Shift+J",
  };
  app = await renderApp("/settings/keyboard", {
    seed,
    system: { ...SYSTEM_INFO, platform: "linux" },
  });
  await screen.findByRole("heading", { name: "Keyboard" });
  const updatePrefs = vi.spyOn(app.db, "updatePrefs");
  const row = document.querySelector<HTMLElement>(
    '[data-setting-id="key-toggle-sidebar"]'
  )!;
  fireEvent.click(within(row).getByRole("button", { name: "Change" }));
  fireEvent.keyDown(document.body, {
    key: "j",
    code: "KeyJ",
    ctrlKey: true,
    shiftKey: true,
  });
  fireEvent.click(await screen.findByRole("button", { name: "Use anyway" }));
  await waitFor(() =>
    expect(app!.collections.prefs.get("app")?.keymap).toEqual({
      "new-in-area": null,
      "close-tab@terminal": null,
      "toggle-sidebar": "Mod+Shift+J",
    })
  );
  expect(updatePrefs).toHaveBeenCalledTimes(1);
  expect(updatePrefs).toHaveBeenCalledWith({
    keymap: {
      "new-in-area": null,
      "close-tab@terminal": null,
      "toggle-sidebar": "Mod+Shift+J",
    },
  });
});
it("a fixed live conflict blocks reassignment even alongside a stored rebindable conflict", async () => {
  const seed = defaultSeed();
  seed.prefs!.keymap = { "new-in-area": "Ctrl+Shift+J" };
  app = await renderApp("/settings/keyboard", {
    seed,
    system: { ...SYSTEM_INFO, platform: "linux" },
  });
  await screen.findByRole("heading", { name: "Keyboard" });
  const handle = getSequenceManager().register(["Mod+Shift+J", "K"], () => {}, {
    platform: "linux",
    meta: { description: "Fixed sequence" },
  });
  try {
    const row = document.querySelector<HTMLElement>(
      '[data-setting-id="key-toggle-sidebar"]'
    )!;
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    fireEvent.keyDown(document.body, {
      key: "j",
      code: "KeyJ",
      ctrlKey: true,
      shiftKey: true,
    });
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Use anyway" })).toBeNull();
    expect(app.collections.prefs.get("app")?.keymap).toEqual(
      seed.prefs!.keymap
    );
  } finally {
    handle.unregister();
  }
});
