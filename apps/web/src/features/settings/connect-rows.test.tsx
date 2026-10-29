/**
 * A provider or account sign-in in Settings waits on its own row: the page,
 * the other rows and navigation stay usable, Cancel hands the row back, a
 * cancelled sign-in's late answer is ignored, and a failure shows on its row.
 */
import { contract } from "@abacus-ai/contract/contract";
import type { OpenRouterAuthOutcome } from "@abacus-ai/contract/contracts";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

/** A sign-in the browser has not answered; `answer` settles the latest. */
const browserWait = () => {
  let answer: (outcome: OpenRouterAuthOutcome) => void = () => {};
  const start = vi.fn(
    () =>
      new Promise<OpenRouterAuthOutcome>((resolve) => {
        answer = resolve;
      })
  );
  return {
    start,
    cancel: vi.fn(),
    answer: (o: OpenRouterAuthOutcome) => answer(o),
  };
};
const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`)!;

it("Settings > Models: OpenRouter waits on its row after the dialog closes, with Cancel", async () => {
  const hop = browserWait();
  app = await renderApp("/settings/models?provider=openrouter", {
    procedures: {
      auth: {
        openRouter: {
          start: os.auth.openRouter.start.handler(hop.start),
          cancel: os.auth.openRouter.cancel.handler(hop.cancel),
        },
      },
    },
  });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
  await within(dialog).findByText("Waiting for sign-in…");
  // The dialog closes while the browser waits; the row keeps the wait.
  fireEvent.click(
    within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const openRouter = row("provider-openrouter");
  expect(within(openRouter).getByRole("status").textContent).toBe(
    "Waiting for sign-in…"
  );
  // Every other row is still usable.
  const gemini = within(row("provider-gemini")).getByRole("button");
  expect((gemini as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(gemini);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(within(openRouter).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(hop.cancel).toHaveBeenCalled());
  expect(within(row("provider-openrouter")).queryByRole("status")).toBeNull();
  // The cancelled sign-in's late answer changes nothing.
  hop.answer({ ok: false, error: "late" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("Settings > Models: a failed OpenRouter sign-in says why under its row", async () => {
  app = await renderApp("/settings/models?provider=openrouter", {
    procedures: {
      auth: {
        openRouter: {
          start: os.auth.openRouter.start.handler(() => ({
            ok: false as const,
            error: "Timed out",
          })),
        },
      },
    },
  });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Timed out"
  );
  fireEvent.click(
    within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Timed out");
  expect(alert.parentElement?.contains(row("provider-openrouter"))).toBe(true);
  expect(
    within(row("provider-openrouter")).getByRole("button", { name: "Connect" })
  ).toBeTruthy();
});

it("Settings > Account: the sign-in waits on its button with Cancel; the page stays usable", async () => {
  const hop = browserWait();
  // A stored key the account service no longer answers for: Account offers Sign in.
  app = await renderApp("/settings/account", {
    procedures: {
      auth: {
        abacus: {
          start: os.auth.abacus.start.handler(hop.start),
          cancel: os.auth.abacus.cancel.handler(hop.cancel),
        },
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("status")).textContent).toBe(
    "Waiting for sign-in…"
  );
  const ownKeys = screen.getByRole("button", { name: "Use my own keys" });
  expect((ownKeys as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(hop.cancel).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  hop.answer({ ok: false, error: "late" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("alert")).toBeNull();
});
