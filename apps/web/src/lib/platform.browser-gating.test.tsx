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
