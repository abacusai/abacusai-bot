/** R1-T4 (sessions): filtering, workspace grouping, pinned group, live updates. */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createDb, type Db } from "#next/data/db";
import { fixtureTransport, FixtureDb } from "#next/data/fixture-db/fixture-db";
import {
  fixturePrefs,
  fixtureSessions,
  fixtureWorkspaces,
} from "#next/data/fixture-db/rows";
import { renderInRouter } from "#next/test-support/render-in-router";

import { groupSessions, SessionsSidebar } from "./sessions-sidebar";

let appDb: Db | null = null;
afterEach(async () => {
  appDb?.stop();
  for (const collection of Object.values(appDb?.collections ?? {}))
    await collection.cleanup().catch(() => undefined);
  appDb = null;
});

const NOW = 1_800_000_000_000;

describe("groupSessions", () => {
  it("drops bot chats, routine runs, routine editors and hidden workspaces; groups the rest", () => {
    const { pinned, groups } = groupSessions(
      fixtureSessions(NOW),
      fixtureWorkspaces(),
      ["fix-sidebar-width"]
    );
    expect(pinned.map((s) => s.id)).toEqual(["fix-sidebar-width"]);
    expect(groups.map((g) => g.workspace.id)).toEqual([
      "abacusai-bot",
      "default",
    ]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual([
      "review-prs",
      "terminal-tab",
      "compress-installers",
    ]);
    const all = groups.flatMap((g) => g.sessions.map((s) => s.id));
    for (const hidden of ["bot-chat", "routine-run", "routine-editor"])
      expect(all).not.toContain(hidden);
  });
});

describe("SessionsSidebar", () => {
  it("renders groups live and never shows filtered sessions", async () => {
    const db = new FixtureDb({
      prefs: fixturePrefs(),
      sessions: fixtureSessions(NOW),
      workspaces: fixtureWorkspaces(),
    });
    appDb = createDb(fixtureTransport(db), { retryDelayMs: () => 5 });
    await renderInRouter(<SessionsSidebar />, appDb);
    await screen.findByText("Review my pull requests");
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByText("Default workspace")).toBeTruthy();
    expect(screen.queryByText("Morning digest run")).toBeNull();
    expect(screen.queryByText("Editing a routine")).toBeNull();
    act(() => {
      db.sessions.upsert({
        ...db.sessions.rows.get("flights")!,
        label: "Find cheaper flights",
      });
    });
    await screen.findByText("Find cheaper flights");
    act(() => {
      db.sessions.remove("spreadsheet");
    });
    await waitFor(() =>
      expect(screen.queryByText("Clean up a spreadsheet")).toBeNull()
    );
  });
});
