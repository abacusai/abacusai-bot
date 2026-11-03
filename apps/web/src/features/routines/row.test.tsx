import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { ROUTINE_PAUSE_NOTES } from "@abacus-ai/contract/routines";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";

import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

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

const QUIET =
  "Paused: 3 runs in a row found nothing new, so it stopped using credits. Resume it to keep checking.";

it.each([
  ["quiet runs", ROUTINE_PAUSE_NOTES.quiet, false, QUIET],
  [
    "failures",
    ROUTINE_PAUSE_NOTES.failures,
    false,
    "Paused after failing several times.",
  ],
  ["credits", ROUTINE_PAUSE_NOTES.credits, false, "Paused: out of credits."],
  ["a deleted bot", "paused: its bot was deleted", false, null],
  ["quiet runs, since resumed", ROUTINE_PAUSE_NOTES.quiet, true, null],
  ["the user's own pause", null, false, null],
])(
  "a local routine paused for %s names the reason main recorded, if any",
  async (_, note, enabled, line) => {
    const seed = defaultSeed();
    const [first, ...rest] = seed.routines!;
    const routine: RoutineRow = {
      ...first!,
      enabled,
      recentRuns: (note == null ? [] : [note]).map((result) => ({
        id: "attempt-p",
        at: 1_800_000_000_000,
        trigger: "schedule",
        result,
        kind: "paused" as const,
        sessionId: null,
        attemptId: null,
      })),
    };
    const app = await renderApp(`/routines/${routine.id}`, {
      seed: { ...seed, routines: [routine, ...rest] },
    });
    try {
      await screen.findByRole("heading", { name: routine.name });
      for (const text of [
        QUIET,
        "Paused after failing several times.",
        "Paused: out of credits.",
      ])
        expect(screen.queryByText(text) != null).toBe(text === line);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  }
);
