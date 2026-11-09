/**
 * The status board's in-app side, read from `status.list`: a routine the app
 * paused shows its dot and its reason, from the board rather than its own row.
 */
import type { StatusItem } from "@abacus-ai/contract/status";
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

it("a routine the app paused shows its dot and line in the list, and Resume on its page", async () => {
  const paused: StatusItem = {
    key: "routine:morning-digest",
    state: "paused-by-app",
    reason: "quiet",
    since: 1_800_000_000_000,
    detail: { routineId: "morning-digest", name: "Morning digest" },
  };
  const app = await renderApp("/routines/morning-digest", {
    statusItems: [paused],
  });
  try {
    await screen.findAllByText(
      "Paused: 3 runs in a row found nothing new, so it stopped using credits. Resume it to keep checking."
    );
    expect(
      document.querySelector(
        '[data-slot="status-dot"][data-state="paused-by-app"]'
      )
    ).not.toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
