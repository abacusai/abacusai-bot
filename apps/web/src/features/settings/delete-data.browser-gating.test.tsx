import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";

it("does not offer host data deletion in a browser", async () => {
  const app = await renderApp("/settings/account");
  try {
    await screen.findByRole("heading", { name: enUS.settings.pages.account });
    expect(
      screen.queryByRole("button", { name: enUS.settings.deleteAllData.title })
    ).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
