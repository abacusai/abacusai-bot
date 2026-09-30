import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#next/test-support/app-harness";

it("R5-T8 routine form does not accept whitespace-only instructions", async () => {
  const app = await renderApp("/routines/new");
  try {
    const instruction = await screen.findByRole("textbox", {
      name: "Instruction",
    });
    fireEvent.change(instruction, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe("/routines/new")
    );
    expect(await screen.findByText("Enter an instruction")).not.toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
it("R5-T8 dirty routine cancellation uses a discard dialog and keeps the draft on cancel", async () => {
  const app = await renderApp("/routines/new");
  try {
    const instruction = await screen.findByRole("textbox", {
      name: "Instruction",
    });
    fireEvent.change(instruction, { target: { value: "Draft instruction" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alertdialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((instruction as HTMLTextAreaElement).value).toBe(
      "Draft instruction"
    );
    expect(app.router.state.location.pathname).toBe("/routines/new");
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
