/** R3-T20,T22: real routed pages and gallery components, axe and identity exclusivity. */
import { screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";

import { renderApp } from "#next/test-support/app-harness";
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
describe("bots accessibility", () => {
  it.each([
    "/bots/new",
    "/bots/new?step=setup&template=chief-of-staff",
    "/bots/chief-of-staff?tab=details",
    "/bots/chief-of-staff?tab=memory",
    "/bots/chief-of-staff?tab=files",
    "/bots/chief-of-staff/check-in",
    ...[
      "bots-avatar",
      "bots-connector-marks",
      "bots-sidebar",
      "bots-start",
      "bots-setup",
      "bots-panel",
      "bots-memory",
      "bots-files",
      "bots-check-in",
    ].map((id) => `/__ui?fixture=${id}`),
  ])(
    "%s passes axe",
    async (path) => {
      app = await renderApp(path);
      await waitFor(() =>
        expect(
          document.querySelector('[data-testid="pending-pane"]')
        ).toBeNull()
      );
      const result = await axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
        rules: {
          "color-contrast": { enabled: false },
          region: { enabled: false },
        },
      });
      expect(
        result.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`
        )
      ).toEqual([]);
    },
    20000
  );
  it("only the transcript identity is accessible while undocked", async () => {
    app = await renderApp("/bots/chief-of-staff");
    await screen.findByTestId("bot-chat");
    expect(
      screen.getAllByRole("button", { name: "Details for Chief of Staff" })
    ).toHaveLength(1);
  });
});
