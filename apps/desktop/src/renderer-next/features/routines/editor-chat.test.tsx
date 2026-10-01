import { implement, ORPCError } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { fixtureRoutines } from "#next/data/fixture-db/rows";
import { renderApp } from "#next/test-support/app-harness";
import { contract } from "#shared/contract";
const os = implement(contract);
const row = fixtureRoutines()[0]!;
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  sessionStorage.clear();
});
it("R5-T12 the mounted editor sends trimmed text once, disables the field and restores ten exchanges", async () => {
  let release!: (value: { reply: string }) => void;
  const edit = vi.fn(
    async (_input: unknown) =>
      new Promise<{ reply: string }>((resolve) => {
        release = resolve;
      })
  );
  const procedures = {
    routines: { editByChat: os.routines.editByChat.handler(edit) },
  };
  sessionStorage.setItem(
    `routine-editor:${row.id}`,
    JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({
        user: `old ${i}`,
        reply: `reply ${i}`,
      }))
    )
  );
  app = await renderApp(`/routines/${row.id}`, { procedures });
  const field = await screen.findByRole("textbox", {
    name: "Tell the routine how to change",
  });
  fireEvent.change(field, { target: { value: "  every day at 7  " } });
  fireEvent.submit(field.closest("form")!);
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
  expect(edit.mock.calls[0]![0]).toMatchObject({
    input: { routineId: row.id, text: "every day at 7" },
  });
  expect(field.hasAttribute("disabled")).toBe(true);
  release({ reply: "Changed to 7" });
  await waitFor(() => expect(field.hasAttribute("disabled")).toBe(false));
  const log = JSON.parse(sessionStorage.getItem(`routine-editor:${row.id}`)!);
  expect(log).toHaveLength(10);
  expect(log[0].user).toBe("old 1");
  expect(log.at(-1)).toEqual({ user: "every day at 7", reply: "Changed to 7" });
  app.view.unmount();
  await app.cleanup();
  app = await renderApp(`/routines/${row.id}`, { procedures });
  expect(await screen.findAllByText("Changed to 7")).toHaveLength(2);
});
it.each(["TIMEOUT", "NOT_FOUND", "INTERNAL_SERVER_ERROR"] as const)(
  "R5-T12 handles %s through the real typed transport",
  async (code) => {
    app = await renderApp(`/routines/${row.id}`, {
      procedures: {
        routines: {
          editByChat: os.routines.editByChat.handler(() => {
            throw new ORPCError(code, { message: "Provider failed" });
          }),
        },
      },
    });
    const field = await screen.findByRole("textbox", {
      name: "Tell the routine how to change",
    });
    fireEvent.change(field, { target: { value: "change it" } });
    fireEvent.submit(field.closest("form")!);
    if (code === "NOT_FOUND")
      expect(await screen.findByText("This routine is gone.")).not.toBeNull();
    else
      await waitFor(() => expect(field.hasAttribute("disabled")).toBe(false));
    expect(
      JSON.parse(sessionStorage.getItem(`routine-editor:${row.id}`)!)
    ).toHaveLength(1);
  }
);

it("navigation between routines isolates editor history and drafts", async () => {
  const other = fixtureRoutines()[1]!;
  sessionStorage.setItem(
    `routine-editor:${row.id}`,
    JSON.stringify([{ user: "First routine request", reply: "First reply" }])
  );
  sessionStorage.setItem(
    `routine-editor:${other.id}`,
    JSON.stringify([{ user: "Second routine request", reply: "Second reply" }])
  );
  app = await renderApp(`/routines/${row.id}`);
  const field = await screen.findByRole("textbox", {
    name: "Tell the routine how to change",
  });
  fireEvent.change(field, { target: { value: "Unsaved first draft" } });
  await act(async () => {
    await app!.router.navigate({
      to: "/routines/$routineId",
      params: { routineId: other.id },
    });
  });
  expect(await screen.findByText("Second routine request")).not.toBeNull();
  expect(screen.queryByText("First routine request")).toBeNull();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Tell the routine how to change",
      }) as HTMLTextAreaElement
    ).value
  ).toBe("");
});
