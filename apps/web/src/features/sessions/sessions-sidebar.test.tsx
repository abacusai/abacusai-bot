/** R1-T4 (sessions): filtering, workspace grouping, pinned group, live updates. */
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  fixturePrefs,
  fixtureSessions,
  fixtureWorkspaces,
} from "#renderer/data/fixture-db/rows";
import { renderApp } from "#renderer/test-support/app-harness";

import { groupSessions } from "./sessions-sidebar";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const NOW = 1_800_000_000_000;

describe("groupSessions", () => {
  it("keeps personal sessions in a hosted-runs workspace while excluding recorded hosted runs, including pins", () => {
    const seed = fixtureSessions(NOW)[0]!;
    const personal = {
      ...seed,
      id: "personal",
      workspaceId: "hosted-runs",
      label: "Routine: my own notes",
      routineId: null,
      runTrigger: "user",
    };
    const run = {
      ...seed,
      id: "hosted-run",
      workspaceId: "hosted-runs",
      label: "Renamed run",
      routineId: null,
      runTrigger: "hosted",
    };
    const workspace = {
      ...fixtureWorkspaces()[0]!,
      id: "hosted-runs",
      label: "hosted-runs",
    };
    const grouped = groupSessions(
      [personal, run],
      [workspace],
      [run.id, personal.id]
    );
    expect(grouped.pinned.map((session) => session.id)).toEqual([personal.id]);
    expect(grouped.groups).toEqual([]);
  });
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
    app = await renderApp("/sessions/new", {
      seed: {
        prefs: fixturePrefs(),
        sessions: fixtureSessions(NOW),
        workspaces: fixtureWorkspaces(),
      },
    });
    const db = app.db;
    const sidebar = within(
      screen.getByRole("navigation", { name: "Sessions" })
    );
    await sidebar.findByText("Review my pull requests");
    expect(sidebar.getByText("Pinned")).toBeTruthy();
    expect(sidebar.getByText(/^Default workspace/)).toBeTruthy();
    expect(sidebar.queryByText("Morning digest run")).toBeNull();
    expect(sidebar.queryByText("Editing a routine")).toBeNull();
    act(() => {
      db.sessions.upsert({
        ...db.sessions.rows.get("flights")!,
        label: "Find cheaper flights",
      });
    });
    await sidebar.findByText("Find cheaper flights");
    act(() => {
      db.sessions.remove("spreadsheet");
    });
    await waitFor(() =>
      expect(sidebar.queryByText("Clean up a spreadsheet")).toBeNull()
    );
  });
});
