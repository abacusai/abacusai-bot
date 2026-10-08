import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

vi.mock("#renderer/features/shell/connect/services", async (original) => ({
  ...(await original<
    typeof import("#renderer/features/shell/connect/services")
  >()),
  callApps: async () => ({
    available: true,
    status: "unlinked",
    number: null,
  }),
}));

it("restores the phone dialog from search and preserves the shell and history", async () => {
  const seed = defaultSeed();
  seed.prefs!.dismissals.whatsappIntroAt = 1;
  const app = await renderApp("/bots", { seed });
  try {
    await act(async () => {
      await app.router.navigate({
        to: "/bots",
        search: (previous) => ({ ...previous, connect: "whatsapp" as const }),
        state: { whatsappDialog: true },
      });
    });
    expect(
      await screen.findByRole("dialog", { name: "Connect your WhatsApp" })
    ).toBeTruthy();
    expect(document.querySelector('[data-slot="shell"]')).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(app.router.state.location.search.connect).toBeUndefined()
    );
    await act(async () => {
      app.router.history.forward();
    });
    await waitFor(() =>
      expect(app.router.state.location.search.connect).toBe("whatsapp")
    );
    expect(
      await screen.findByRole("dialog", { name: "Connect your WhatsApp" })
    ).toBeTruthy();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
