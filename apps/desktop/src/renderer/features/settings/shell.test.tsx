import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

it("R5-T22 Back to the app returns past settings pages to the requesting location", async () => {
  const app = await renderApp("/routines");
  try {
    await act(() => app.router.navigate({ to: "/settings/general" }));
    await act(() => app.router.navigate({ to: "/settings/appearance" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Back to the app" })
    );
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/routines")
    );
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
