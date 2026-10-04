import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { windowChromeQuery } from "#renderer/data/queries/window";
import { ReadinessReporter } from "#renderer/features/shell/readiness";
import { createHarness } from "#renderer/test-support/app-harness";

import { installActivity } from "./activity";
import { reportFailedBoot } from "./bootstrap";
import { IS_BROWSER, uiPlatform } from "./platform";
it("browser uses the user's OS and never enters Electron readiness", async () => {
  expect(IS_BROWSER).toBe(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  expect(uiPlatform("linux")).toBe("mac");
  const app = await createHarness("/bots");
  try {
    expect(windowChromeQuery(app.transport.orpc).enabled).toBe(false);
    render(
      <ReadinessReporter
        transport={app.transport}
        collections={app.collections}
      />
    );
    await reportFailedBoot(app.transport, "failure");
    const stop = installActivity(app.transport);
    window.dispatchEvent(new Event("pointerdown"));
    stop();
    expect(app.calls.filter(([path]) => path.startsWith("window."))).toEqual(
      []
    );
  } finally {
    await app.cleanup();
  }
});

it("Mac browser terminal copy/paste and Mod shortcuts use Mac keys on a Linux host", async () => {
  const { terminalKeyHandler } =
    await import("#renderer/components/terminal/keys");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText: vi.fn().mockResolvedValue("paste") },
  });
  const dispatch = vi.fn();
  const terminal = {
    hasSelection: () => true,
    getSelection: () => "selected",
    paste: vi.fn(),
    scrollPages: vi.fn(),
    scrollToBottom: vi.fn(),
  };
  const key = terminalKeyHandler(uiPlatform("linux"), dispatch, terminal, {
    "new-in-area": "Mod+N",
  });
  expect(key(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(
    true
  );
  expect(writeText).toHaveBeenCalledWith("selected");
  expect(key(new KeyboardEvent("keydown", { key: "v", metaKey: true }))).toBe(
    true
  );
  await Promise.resolve();
  expect(terminal.paste).toHaveBeenCalledWith("paste");
  expect(key(new KeyboardEvent("keydown", { key: "n", metaKey: true }))).toBe(
    true
  );
  expect(dispatch).toHaveBeenCalledWith("new");
});
