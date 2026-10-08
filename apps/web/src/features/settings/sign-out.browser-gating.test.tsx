import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";

it("offers website sign-out without a host API key and shows a failed logout in the dialog", async () => {
  const os = implement(contract);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, error: "Please retry sign-out" }),
          { status: 500 }
        )
    )
  );
  const app = await renderApp("/settings/account", {
    procedures: {
      account: {
        abacus: os.account.abacus.handler(
          () => ({ name: "Ada Example", email: "ada@example.com" }) as never
        ),
      },
      settings: {
        get: os.settings.get.handler(
          () => ({ apiKeys: { ABACUS_API_KEY: "dummy" } }) as never
        ),
      },
    },
  });
  try {
    await screen.findByRole("button", { name: enUS.phase5.signOut });
    await act(async () => {
      app.router.options.context.queryClient.setQueryData(
        app.transport.orpc.settings.get.queryKey({ input: {} }),
        (old) => (old == null ? old : { ...old, apiKeys: {} })
      );
    });
    fireEvent.click(
      await screen.findByRole("button", { name: enUS.phase5.signOut })
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: enUS.phase5.signOut })
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Please retry sign-out"
    );
    expect(app.transport.state).toBe("open");
    expect(app.appDb.stopped).toBe(false);
    expect(
      screen.queryByRole("checkbox", { name: enUS.phase5.removeOtherKeys })
    ).toBeNull();
  } finally {
    vi.unstubAllGlobals();
    app.view.unmount();
    await app.cleanup();
  }
});
