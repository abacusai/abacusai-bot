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
