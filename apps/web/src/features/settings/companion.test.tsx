import { contract } from "@abacus-ai/contract/contract";
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
it("R7-T25 NT7 failed companion can retry and saves the enabled leaf", async () => {
  const retry = vi.fn(() => ({
    available: true,
    displays: 1,
    shortcut: "registered" as const,
  }));
  app = await renderApp("/settings/general", {
    procedures: {
      notch: {
        status: os.notch.status.handler(() => ({
          available: false,
          reason: "failed",
          displays: 0,
          shortcut: "off",
        })),
        retry: os.notch.retry.handler(retry),
      },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  const row = within(
    document.querySelector<HTMLElement>('[data-setting-id="notchCompanion"]')!
  );
  fireEvent.click(row.getByRole("switch"));
  await waitFor(() =>
    expect(app!.collections.prefs.get("app")?.notch?.enabled).toBe(false)
  );
});
it("R7-T25 NT7 Linux hides companion controls while keeping tour replay", async () => {
  app = await renderApp("/settings/general", {
    procedures: {
      notch: {
        status: os.notch.status.handler(() => ({
          available: false,
          reason: "platform",
          displays: 0,
          shortcut: "off",
        })),
      },
    },
  });
  await screen.findByRole("button", { name: "Take the tour" });
  expect(
    document.querySelector('[data-setting-id="notchCompanion"]')
  ).toBeNull();
});
