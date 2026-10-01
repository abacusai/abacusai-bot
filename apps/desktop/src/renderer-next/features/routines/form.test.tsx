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

it("R5-T8 successive remote values refresh untouched fields and save only the edited instruction", async () => {
  const { act } = await import("@testing-library/react");
  const { fixtureRoutines } = await import("#next/data/fixture-db/rows");
  const row = fixtureRoutines()[0]!;
  const app = await renderApp(`/routines/${row.id}/edit`);
  try {
    const name = await screen.findByRole("textbox", { name: /^Name/ });
    const instruction = screen.getByRole("textbox", { name: "Instruction" });
    fireEvent.blur(name);
    fireEvent.change(instruction, { target: { value: "  My instruction  " } });
    for (const remote of ["Remote one", "Remote two"]) {
      await act(async () => {
        app.db.routines.upsert({
          ...row,
          name: remote,
          prompt: "Remote instruction",
        });
      });
      await waitFor(() =>
        expect((name as HTMLInputElement).value).toBe(remote)
      );
      expect((instruction as HTMLTextAreaElement).value).toBe(
        "  My instruction  "
      );
      expect(name.getAttribute("aria-invalid")).not.toBe("true");
    }
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(app.collections.routines.get(row.id)).toMatchObject({
        name: "Remote two",
        prompt: "My instruction",
      })
    );
    await waitFor(() =>
      expect(app.router.state.location.pathname).toBe(`/routines/${row.id}`)
    );
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("R5-T4 a deleted routine exits its edit controls", async () => {
  const { act } = await import("@testing-library/react");
  const { fixtureRoutines } = await import("#next/data/fixture-db/rows");
  const row = fixtureRoutines()[0]!;
  const app = await renderApp(`/routines/${row.id}/edit`);
  try {
    await screen.findByRole("textbox", { name: "Instruction" });
    await act(async () => {
      app.db.routines.remove(row.id);
    });
    expect(await screen.findByText("This routine is gone.")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Instruction" })).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("successful create with whitespace navigates without a discard blocker", async () => {
  const app = await renderApp("/routines/new");
  try {
    fireEvent.change(await screen.findByRole("textbox", { name: /^Name/ }), {
      target: { value: " Brief " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Instruction" }), {
      target: { value: " Summarize today " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(app.router.state.location.pathname).not.toBe("/routines/new")
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
