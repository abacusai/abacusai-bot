import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { renderApp, SYSTEM_INFO } from "#renderer/test-support/app-harness";

it("updates the shared rail from the account RPC rather than the host home directory", async () => {
  vi.stubGlobal(
    "Image",
    class {
      complete = true;
      naturalWidth = 32;
    }
  );
  const os = implement(contract);
  const app = await renderApp("/settings/account", {
    system: { ...SYSTEM_INFO, homeDir: "/home/ubuntu" },
    procedures: {
      account: {
        abacus: os.account.abacus.handler(
          () =>
            ({
              name: "Ada Example",
              email: "ada@example.com",
              picture: null,
            }) as never
        ),
      },
    },
  });
  try {
    const account = await screen.findByRole("button", { name: "Ada Example" });
    await waitFor(() => expect(account.textContent).toContain("AE"));
    expect(account.textContent).not.toContain("UB");
    expect(await screen.findByText("ada@example.com")).toBeDefined();
    await act(async () => {
      app.router.options.context.queryClient.setQueryData(
        app.transport.orpc.account.abacus.queryKey({
          input: { refresh: true },
        }),
        (old) =>
          old == null
            ? old
            : {
                ...old,
                name: "Grace Example",
                email: "grace@example.com",
                picture: "data:image/png;base64,AQID",
              }
      );
    });
    const changed = await screen.findByRole("button", {
      name: "Grace Example",
    });
    await waitFor(() =>
      expect(changed.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,AQID"
      )
    );
  } finally {
    vi.unstubAllGlobals();
    app.view.unmount();
    await app.cleanup();
  }
});
