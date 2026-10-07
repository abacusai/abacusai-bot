import { expect, it } from "vitest";

import {
  rankCommands,
  highlightCommand,
  type SearchableCommand,
} from "./command-results";
const entries: SearchableCommand[] = [
  { id: "recent", title: "Review model integration", group: "recent" },
  { id: "settings", title: "Models", group: "settings" },
  {
    id: "workspace",
    title: "Sandbox",
    group: "workspaces",
    keywords: ["Project"],
  },
  { id: "sessions", title: "Fix scroll anchors", group: "sessions" },
];
it("keeps recent sessions ahead of sessions and navigation in the idle palette", () => {
  expect(rankCommands(entries, "").map((group) => group.id)).toEqual([
    "recent",
    "sessions",
    "workspaces",
    "settings",
  ]);
});
it("ranks exact section matches ahead of fuzzy matches and searches provider keywords", () => {
  expect(rankCommands(entries, "Models")[0]?.entries[0]?.id).toBe("settings");
  expect(rankCommands(entries, "Project")[0]?.entries[0]?.id).toBe("workspace");
  expect(
    rankCommands(entries, "fsa")
      .flatMap((group) => group.entries)
      .map((entry) => entry.id)
  ).toContain("sessions");
  expect(rankCommands(entries, "zzzznoresults")).toEqual([]);
});
it("highlights matched characters and preserves literal user titles", () => {
  const title = "<Fix scroll anchors>";
  const parts = highlightCommand(title, "fsa");
  expect(parts.map((part) => part.text).join("")).toBe(title);
  expect(
    parts
      .filter((part) => part.matched)
      .map((part) => part.text)
      .join("")
  ).toBe("Fsa");
});
