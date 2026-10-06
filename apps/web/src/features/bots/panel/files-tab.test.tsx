import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

// jsdom cannot lay out the virtualised shadow-DOM tree: a flat stand-in with
// the same contract (select on click, open on double-click).
vi.mock("#renderer/components/file-tree", () => ({
  FileTreeView: ({
    paths,
    onSelect,
    onOpen,
  }: {
    paths: string[];
    onSelect(path: string): void;
    onOpen(path: string): void;
  }) => (
    <ul role="tree">
      {paths.map((path) => (
        <li key={path} role="treeitem">
          <button
            onClick={() => onSelect(path)}
            onDoubleClick={() => onOpen(path)}
          >
            {path}
          </button>
        </li>
      ))}
    </ul>
  ),
}));

import { fixtureSessions } from "#renderer/data/fixture-db/rows";
import { panelScope, panelScopeKey } from "#renderer/lib/side-panel/store";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const artifact = (sessionId: string, location: string) => ({
  id: `${sessionId}::${location}`,
  workspaceId: "abacusai-bot",
  sessionId,
  kind: "file" as const,
  title: location.split("/").at(-1)!,
  location,
  toolName: "present_deliverable",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

it("the Files tab is a tree of the bot's files; a click previews here, Enter opens a new Files tab", async () => {
  app = await renderApp("/bots/chief-of-staff?tab=files", {
    seed: {
      ...defaultSeed(),
      sessions: [
        {
          ...fixtureSessions()[0]!,
          id: "bot-test",
          workspaceId: "abacusai-bot",
          owner: {
            kind: "bot",
            botId: "chief-of-staff",
            role: "forever",
            key: "forever",
          },
        },
      ],
      artifacts: [
        artifact("bot-test", "/Users/you/code/abacusai-bot/out/report.md"),
        artifact("bot-test", "/Users/you/code/abacusai-bot/out/notes.md"),
      ],
    },
  });
  await screen.findByTestId("bot-chat");
  const key = panelScopeKey("bots", "chief-of-staff")!;
  await screen.findByRole("tree");
  // Paths relative to the workspace: the folder, then both files under it.
  await waitFor(() =>
    expect(
      screen.getAllByRole("treeitem").map((item) => item.textContent)
    ).toEqual(["out/", "out/notes.md", "out/report.md"])
  );
  const file = screen.getByText("out/report.md");
  fireEvent.click(file);
  await waitFor(() =>
    expect(panelScope(key).tabs.find((tab) => tab.kind === "files")?.path).toBe(
      "/Users/you/code/abacusai-bot/out/report.md"
    )
  );
  await waitFor(() =>
    expect(document.querySelector('[data-slot="file-preview"]')).not.toBeNull()
  );
  // Opening (double-click / Enter) the file: a second Files tab for it.
  fireEvent.doubleClick(screen.getByText("out/report.md"));
  await waitFor(() =>
    expect(
      panelScope(key).tabs.filter((tab) => tab.kind === "files")
    ).toHaveLength(2)
  );
  // "Back to files" clears this tab's file; the tree stays.
  await act(async () => {
    fireEvent.click(
      screen.getAllByRole("button", { name: "Back to files" })[0]!
    );
  });
  await waitFor(() =>
    expect(
      panelScope(key).tabs.find((tab) => tab.id === panelScope(key).active)
        ?.path
    ).toBeUndefined()
  );
});
