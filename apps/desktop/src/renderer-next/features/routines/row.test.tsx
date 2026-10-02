import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#next/test-support/app-harness";

it("R5-T13 the named row menu pauses and resumes through the real collection", async () => {
  const app = await renderApp("/routines/morning-digest");
  try {
    const row = app.collections.routines.get("morning-digest")!;
    const options = await screen.findByRole("button", {
      name: `Options for ${row.name}`,
    });
    fireEvent.click(options);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() =>
      expect(app.collections.routines.get(row.id)?.enabled).toBe(false)
    );
    fireEvent.click(options);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
    await waitFor(() =>
      expect(app.collections.routines.get(row.id)?.enabled).toBe(true)
    );
    fireEvent.click(options);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("alertdialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(app.collections.routines.get(row.id)).toBeDefined();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
