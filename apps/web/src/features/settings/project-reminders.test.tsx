import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});
const notifyOn = {
  settings: {
    notifications: {
      get: os.settings.notifications.get.handler(() => ({
        enabled: true,
        sound: true,
      })),
    },
  },
};
const row = async (id: string) =>
  within(
    await waitFor(
      () => {
        const node = document.querySelector<HTMLElement>(
          `[data-setting-id="${id}"]`
        );
        if (!node) throw new Error(`no ${id}`);
        return node;
      },
      { timeout: 5_000 }
    )
  );

it("turns off only the project reminders, on by default", async () => {
  const seed = defaultSeed();
  seed.prefs = fixturePrefs({});
  app = await renderApp("/settings/notifications", {
    seed,
    procedures: notifyOn,
  });
  const reminders = await row("projectReminders");
  expect(reminders.getByText("Reminders about your projects")).toBeTruthy();
  const toggle = reminders.getByRole("switch");
  await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(app!.db.prefs.rows.get("app")?.projectReminders).toBe(false)
  );
  const notify = (await row("notify")).getByRole("switch");
  expect(notify.getAttribute("aria-checked")).toBe("true");
});

it("is held off while Notify me is off", async () => {
  app = await renderApp("/settings/notifications", {
    procedures: {
      settings: {
        notifications: {
          get: os.settings.notifications.get.handler(() => ({
            enabled: false,
            sound: true,
          })),
        },
      },
    },
  });
  const toggle = (await row("projectReminders")).getByRole("switch");
  await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(true));
});
