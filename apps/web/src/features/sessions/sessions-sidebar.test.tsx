/** R1-T4 (sessions): filtering, workspace grouping, pinned group, live updates. */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  fixturePrefs,
  fixtureSessions,
  fixtureWorkspaces,
} from "#renderer/data/fixture-db/rows";
import { renderApp } from "#renderer/test-support/app-harness";

import { groupSessions, nestHandoffs } from "./sessions-sidebar";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
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

  it("lists the user's own sessions in the bot folder, not its bot chats or routine runs", () => {
    const base = fixtureSessions(NOW).find((s) => s.id === "review-prs")!;
    const { groups } = groupSessions(
      [
        { ...base, id: "own", workspaceId: "bot-home" },
        { ...base, id: "bot-chat", workspaceId: "bot-home", botOwned: true },
        {
          ...base,
          id: "routine-run",
          workspaceId: "bot-home",
          routineId: "morning-digest",
        },
      ],
      [
        {
          id: "bot-home",
          label: "Bot home",
          description: "",
          status: "idle",
          kind: "bot",
          isActive: false,
        },
      ],
      []
    );
    expect(
      groups.map((g) => [g.workspace.id, g.sessions.map((s) => s.id)])
    ).toEqual([["bot-home", ["own"]]]);
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

  it("says when a search matches nothing, and recovers when cleared", async () => {
    app = await renderApp("/sessions/new", {
      seed: {
        prefs: fixturePrefs(),
        sessions: fixtureSessions(NOW),
        workspaces: fixtureWorkspaces(),
      },
    });
    const sidebar = within(
      screen.getByRole("navigation", { name: "Sessions" })
    );
    await sidebar.findByText("Review my pull requests");
    const search = sidebar.getByPlaceholderText("Search sessions…");
    fireEvent.change(search, { target: { value: "zzzz-no-such" } });
    await sidebar.findByText("No sessions match");
    expect(sidebar.queryByText("No sessions yet")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    await sidebar.findByText("Review my pull requests");
  });
});

describe("nestHandoffs", () => {
  const base = fixtureSessions(NOW).find((s) => s.id === "review-prs")!;
  const at = (minutes: number) =>
    new Date(NOW + minutes * 60_000).toISOString();
  const chat = (id: string, minutes: number, from?: string) => ({
    ...base,
    id,
    label: id,
    updatedAt: at(minutes),
    ...(from != null
      ? { continuedFrom: from, continuationKind: "handoff" as const }
      : {}),
  });

  it("nests a hand-off and a hand-off of a hand-off under the first chat, newest first, where the newest member sits", () => {
    const families = nestHandoffs([
      chat("other", 5),
      chat("source", 1),
      chat("split-a", 2, "source"),
      chat("split-b", 9, "source"),
      chat("split-of-a", 3, "split-a"),
    ]);
    expect(
      families.map((f) => [f.session.id, f.handoffs.map((h) => h.id)])
    ).toEqual([
      ["source", ["split-b", "split-of-a", "split-a"]],
      ["other", []],
    ]);
  });

  it("leaves a model-switch continuation and a hand-off whose source is elsewhere as rows of their own", () => {
    const families = nestHandoffs([
      chat("source", 1),
      { ...chat("moved", 2), continuedFrom: "source" },
      chat("orphan", 3, "pinned-elsewhere"),
    ]);
    expect(families.map((f) => f.session.id).toSorted()).toEqual([
      "moved",
      "orphan",
      "source",
    ]);
    expect(families.every((f) => f.handoffs.length === 0)).toBe(true);
  });

  it("keeps the pinned list's own order", () => {
    const families = nestHandoffs(
      [chat("first", 1), chat("second", 9), chat("split", 10, "first")],
      true
    );
    expect(families.map((f) => f.session.id)).toEqual(["first", "second"]);
  });

  it("draws a hand-off one step in under its source in the sidebar", async () => {
    app = await renderApp("/sessions/new", {
      seed: {
        prefs: fixturePrefs(),
        sessions: [
          ...fixtureSessions(NOW),
          {
            ...base,
            id: "split",
            label: "Write the release notes",
            updatedAt: at(30),
            continuedFrom: "review-prs",
            continuationKind: "handoff",
          },
        ],
        workspaces: fixtureWorkspaces(),
      },
    });
    const sidebar = within(
      screen.getByRole("navigation", { name: "Sessions" })
    );
    const split = await sidebar.findByText("Write the release notes");
    const source = sidebar.getByText("Review my pull requests");
    const rows = sidebar
      .getAllByRole("link")
      .filter((link) => link.textContent !== "");
    const order = rows.map((link) => link.textContent ?? "");
    const sourceAt = order.findIndex((text) =>
      text.includes("Review my pull requests")
    );
    expect(order[sourceAt + 1]).toContain("Write the release notes");
    expect(split.closest("a")?.className).toContain("before:w-px");
    expect(source.closest("a")?.className).not.toContain("before:w-px");
  });
});

describe("deleting a chat that owns a hand-off checkout", () => {
  it("says the checkout goes with it, and when it is kept; other chats say nothing of it", async () => {
    const base = fixtureSessions(NOW).find((s) => s.id === "review-prs")!;
    app = await renderApp("/sessions/new", {
      seed: {
        prefs: fixturePrefs(),
        sessions: [
          ...fixtureSessions(NOW),
          {
            ...base,
            id: "split",
            label: "Write the release notes",
            continuedFrom: "review-prs",
            continuationKind: "handoff",
            worktreeId: "wt",
            worktreePath: "/w/notes",
            worktreeBranch: "abacus/write-the-release-notes-1a2b",
            ownsWorktree: true,
          },
        ],
        workspaces: fixtureWorkspaces(),
      },
    });
    const sidebar = within(
      screen.getByRole("navigation", { name: "Sessions" })
    );
    await sidebar.findByText("Write the release notes");
    const open = async (name: string) => {
      fireEvent.click(sidebar.getByRole("button", { name: new RegExp(name) }));
      fireEvent.click(await screen.findByText("Delete session"));
      return screen.findByRole("alertdialog");
    };
    const dialog = await open("Write the release notes");
    expect(
      within(dialog).getByText(
        /abacus\/write-the-release-notes-1a2b goes with it/
      )
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Then it is kept, and you are told/)
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const plain = await open("Review my pull requests");
    expect(within(plain).queryByText(/goes with it/)).toBeNull();
  });
});
