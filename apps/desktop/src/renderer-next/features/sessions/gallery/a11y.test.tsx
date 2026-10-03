import { waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, expect, it } from "vitest";

import { renderApp } from "#next/test-support/app-harness";
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
it.each([
  "/sessions/new",
  "/__ui?fixture=sessions-sidebar",
  "/__ui?fixture=sessions-changes",
  "/__ui?fixture=sessions-missing",
])(
  "R4-T23 %s passes axe",
  async (path) => {
    app = await renderApp(path);
    await waitFor(() =>
      expect(document.querySelector('[data-testid="pending-pane"]')).toBeNull()
    );
    const result = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: {
        "color-contrast": { enabled: false },
        region: { enabled: false },
      },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  },
  20000
);
