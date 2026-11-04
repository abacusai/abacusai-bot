/**
 * The box under a run is the only place to answer it, so what is typed there
 * goes with the run on screen.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { EditorChat } from "./page";

const edit = vi.hoisted(() => vi.fn(async () => ({ reply: "done" })));

vi.mock("#renderer/lib/use-app-context", async (importActual) => ({
  ...(await importActual<object>()),
  useAppContext: () => ({
    transport: { client: { routines: { editByChat: edit } } },
  }),
}));

beforeAll(() => initI18n());

it("sends the run on screen with the words, so they can answer it", async () => {
  render(<EditorChat routineId="job-1" runId="run-7" />);
  const field = screen.getByRole("textbox", {
    name: "Tell the routine how to change",
  });

  fireEvent.change(field, { target: { value: "yes, retry" } });
  fireEvent.submit(field.closest("form")!);

  await waitFor(() =>
    expect(edit).toHaveBeenCalledWith({
      routineId: "job-1",
      text: "yes, retry",
      runId: "run-7",
    })
  );
});
