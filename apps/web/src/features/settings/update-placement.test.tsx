import { contract } from "@abacus-ai/contract/contract";
import type { UpdateStatus } from "@abacus-ai/contract/update";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

const ready: UpdateStatus = {
  checking: false,
  available: true,
  downloading: false,
  downloaded: true,
  installing: false,
  error: null,
  progress: null,
  updateInfo: { version: "2.0.0" },
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
  manualInstall: null,
};

it("offers an update on a new bot page without a rail icon and disables actions while installing", async () => {
  const os = implement(contract);
  let release!: () => void;
  let installs = 0;
  const app = await renderApp("/bots/new", {
    procedures: {
      update: {
        status: os.update.status.handler(() => ready),
        install: os.update.install.handler(async () => {
          installs++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }),
      },
    },
  });
  try {
    await screen.findByText("A new version is ready");
    expect(document.querySelector('[data-slot="rail-update"]')).toBeNull();
    const page = document.querySelector('[data-slot="page-update"]')!;
    expect(page).not.toBeNull();
    fireEvent.click(page.querySelector("button")!);
    await waitFor(() => expect(installs).toBe(1));
    await waitFor(() => expect(page.textContent).toContain("Restarting"));
    expect(page.querySelector("button")).toBeNull();
    release();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("holds the restart offer while a turn runs and offers it when the work ends", async () => {
  const os = implement(contract);
  const busy: UpdateStatus = { ...ready, workRunning: true };
  let endWork!: () => void;
  const workEnded = new Promise<void>((resolve) => {
    endWork = resolve;
  });
  const app = await renderApp("/bots/new", {
    procedures: {
      update: {
        status: os.update.status.handler(() => busy),
        events: os.update.events.handler(async function* ({ signal }) {
          yield busy;
          await workEnded;
          yield ready;
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        }),
      },
    },
  });
  try {
    // The title-bar pill stays the way to restart after the task.
    await screen.findByText("Relaunch to update");
    expect(document.querySelector('[data-slot="page-update"]')).toBeNull();
    endWork();
    await screen.findByText("A new version is ready");
    const page = document.querySelector('[data-slot="page-update"]')!;
    expect(page.textContent).toContain(
      "Relaunch to get the latest improvements and fixes."
    );
    expect(page.querySelector("button")!.textContent).toBe(
      "Relaunch to update"
    );
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
