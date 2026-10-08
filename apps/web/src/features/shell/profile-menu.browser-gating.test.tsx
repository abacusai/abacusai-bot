import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";

import en from "#locales/en-US.json";
import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { renderApp } from "#renderer/test-support/app-harness";

it("opens Agent in a safe web tab and confirms website sign-out without a host key", async () => {
  const os = implement(contract);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const logout = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({ success: false, error: "Please retry sign-out" }),
        { status: 500 }
      )
  );
  vi.stubGlobal("fetch", logout);
  const app = await renderApp("/settings/account", {
    procedures: {
      account: {
        abacus: os.account.abacus.handler(() => ({
          user_id: "dummy",
          organization_id: "dummy-org",
          name: "Ada Example",
          email: "ada@example.com",
          picture: null,
          organization: null,
          org_user_count: 1,
          plan: "Pro",
          subscription_tier: "pro",
          credits_used: null,
          credits_granted: null,
        })),
      },
      settings: {
        get: os.settings.get.handler(
          () => ({ apiKeys: { ABACUS_API_KEY: "dummy" } }) as never
        ),
      },
    },
  });
  try {
    fireEvent.click(
      await screen.findByRole("link", { name: en.profile.agent })
    );
    expect(open).toHaveBeenCalledWith(
      ABACUS_AGENT_URL,
      "_blank",
      "noopener,noreferrer"
    );
    await act(async () =>
      app.router.options.context.queryClient.setQueryData(
        app.transport.orpc.settings.get.queryKey({ input: {} }),
        { apiKeys: {} }
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Ada Example" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: en.profile.logOut })
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      logout.mock.calls.some(([url]) => String(url).endsWith("/signOut"))
    ).toBe(false);
    fireEvent.click(
      within(dialog).getByRole("button", { name: en.profile.logOut })
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Please retry sign-out"
      )
    );
    expect(app.transport.state).toBe("open");
    expect(app.appDb.stopped).toBe(false);
  } finally {
    app.view.unmount();
    await app.cleanup();
    open.mockRestore();
    vi.unstubAllGlobals();
  }
});
