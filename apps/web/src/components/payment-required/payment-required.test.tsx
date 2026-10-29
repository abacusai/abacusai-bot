import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

it("Sign out on the shell's payment screen signs out as the profile menu does", async () => {
  let signedIn = true;
  const signOut = vi.fn(() => {
    signedIn = false;
    return { stashedSessions: 0, removedProviders: [] };
  });
  app = await renderApp("/", {
    procedures: {
      auth: { abacus: { signOut: os.auth.abacus.signOut.handler(signOut) } },
      account: {
        payment: os.account.payment.handler(() =>
          signedIn ? { reason: "lapsed" } : null
        ),
        signOut: os.account.signOut.handler(() => ({
          account: null,
          apps: [],
          onboarded: true,
        })),
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

  await waitFor(() =>
    expect(document.querySelector('[data-slot="payment-required"]')).toBeNull()
  );
  expect(signOut).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ input: { keepOtherApiKeys: true } })
  );
});
