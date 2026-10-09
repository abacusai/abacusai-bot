import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";

const copy = enUS.settings.deleteAllData;
it("requires confirmation, keeps cancel harmless, and allows retry after a refused reset", async () => {
  const erase = vi
    .fn()
    .mockRejectedValueOnce(new Error("Close the other window and retry"))
    .mockResolvedValue(undefined);
  const os = implement(contract);
  const app = await renderApp("/settings/account", {
    procedures: {
      system: {
        deleteAllData: os.system.deleteAllData.handler(({ input }) =>
          erase(input)
        ),
      },
    },
  });
  try {
    fireEvent.click(await screen.findByRole("button", { name: copy.title }));
    const first = await screen.findByRole("alertdialog");
    expect(first.textContent).toContain(copy.confirmation);
    expect(erase).not.toHaveBeenCalled();
    fireEvent.click(
      within(first).getByRole("button", { name: enUS.phase5.cancel })
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(erase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.title }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: copy.confirm }));
    await screen.findByRole("alert");
    expect(erase).toHaveBeenCalledExactlyOnceWith({
      confirmation: "DELETE_ALL_LOCAL_DATA",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.confirm }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(erase).toHaveBeenCalledTimes(2);
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
