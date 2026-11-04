/**
 * A hosted routine's reads are the user's to change on its page: nothing else
 * reaches a routine that was made, or moved, without them.
 */
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { RoutineReachPanel } from "./reach-panel";

beforeAll(() => initI18n());

const saved = vi.hoisted(() => ({ draft: null as RoutineRow | null }));

vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => ({
    transport: {},
    db: {
      collections: {
        routines: {
          update: (_id: string, change: (draft: RoutineRow) => void) => {
            const draft = {
              hosted: { reads: [], sources: [] },
            } as unknown as RoutineRow;
            change(draft);
            saved.draft = draft;
            return { isPersisted: { promise: Promise.resolve() } };
          },
        },
      },
    },
  }),
}));

const row = {
  id: "hosted-r1",
  enabled: true,
  runner: "hosted",
  recentRuns: [],
  hosted: {
    kind: "task",
    reads: ["calendar.read"],
    sources: ["https://news.example/"],
    watchUrl: null,
  },
} as unknown as RoutineRow;

it("adds a read beside the ones it has, and keeps its sources", () => {
  render(<RoutineReachPanel row={row} />);

  fireEvent.click(screen.getByRole("checkbox", { name: "Search Gmail" }));

  expect(saved.draft?.reach).toEqual({
    sources: ["https://news.example/"],
    reads: ["gmail.search", "calendar.read"],
  });
});

it("takes one away", () => {
  render(<RoutineReachPanel row={row} />);

  fireEvent.click(
    screen.getAllByRole("checkbox", { name: "Read Google Calendar" })[0]!
  );

  expect(saved.draft?.reach?.reads).toEqual([]);
});
