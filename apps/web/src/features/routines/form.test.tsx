import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

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
  const { fixtureRoutines } = await import("#renderer/data/fixture-db/rows");
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
  const { fixtureRoutines } = await import("#renderer/data/fixture-db/rows");
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

it("says what an hourly or faster schedule costs where it is picked, and nothing for a daily one", async () => {
  const app = await renderApp("/routines/new");
  try {
    await screen.findByRole("textbox", { name: "Instruction" });
    // The form starts on a daily schedule.
    expect(screen.queryByTestId("routine-frequent")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
    expect((await screen.findByTestId("routine-frequent")).textContent).toBe(
      "Runs 24 times a day, and every run uses credits: at this rate a month's credits can be gone in a few days. If several runs in a row find nothing new, it pauses itself."
    );
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cron expression" }), {
      target: { value: "*/15 * * * *" },
    });
    expect(
      (await screen.findByTestId("routine-frequent")).textContent
    ).toContain("Runs 96 times a day");
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("the full form offers no coding routine: its settings come only with its own setup", async () => {
  const app = await renderApp("/routines/new?template=site-down");
  try {
    const instruction = await screen.findByRole("textbox", {
      name: "Instruction",
    });
    // The search param is not one of the form's templates: a blank form.
    expect((instruction as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Test watch" })).not.toBeNull();
    for (const name of [
      "Tell me when my site is down",
      "Run my tests and fix failures",
      "Fix review comments on my PRs",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("a coding routine's setup offers the user's folders and Choose a folder, never the app's own workspace", async () => {
  const os = implement(contract);
  // GitHub connected and no repo open: the setup asks for the project.
  const app = await renderApp("/routines", {
    procedures: {
      connectors: {
        statuses: os.connectors.statuses.handler(() => ({
          "abacus-githubbot": { state: "connected" },
        })),
      },
    },
  });
  try {
    fireEvent.click(
      await screen.findByTestId("coding-routine-pr-review-fixes")
    );
    const project = (await screen.findByRole("combobox", {
      name: "Project",
    })) as HTMLSelectElement;
    const options = Array.from(project.options, (option) => option.text);
    expect(options).toContain("abacusai-bot");
    expect(options).not.toContain("Default workspace");
    expect(options.at(-1)).toBe("Choose a folder…");
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});

it("the full form names the app's own workspace and ends on Choose a folder", async () => {
  const app = await renderApp("/routines/new");
  try {
    const folder = (await screen.findByRole("combobox", {
      name: "Folder",
    })) as HTMLSelectElement;
    const options = Array.from(folder.options, (option) => option.text);
    expect(options[0]).toBe("Its own folder");
    expect(options).toContain("Default workspace");
    expect(options.at(-1)).toBe("Choose a folder…");
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
