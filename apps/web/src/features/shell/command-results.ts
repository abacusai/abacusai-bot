import { defaultFilter } from "cmdk";

export const COMMAND_GROUPS = [
  "recent",
  "sessions",
  "bots",
  "workspaces",
  "actions",
  "settings",
  "navigation",
  "panels",
] as const;
export type CommandGroupId = (typeof COMMAND_GROUPS)[number];
export interface SearchableCommand {
  id: string;
  title: string;
  group: CommandGroupId;
  keywords?: string[];
}

/** Keep section semantics; rank sections and items by their best fuzzy match. */
export const rankCommands = <T extends SearchableCommand>(
  entries: T[],
  query: string
) => {
  const search = query.trim();
  const scored = entries
    .map((entry, index) => ({
      entry,
      index,
      score: search ? defaultFilter(entry.title, search, entry.keywords) : 1,
    }))
    .filter(({ score }) => score > 0);
  const groups = COMMAND_GROUPS.map((id) => {
    const items = scored
      .filter(({ entry }) => entry.group === id)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    return {
      id,
      score: items[0]?.score ?? 0,
      entries: items.map(({ entry }) => entry),
    };
  }).filter(({ entries }) => entries.length > 0);
  return search
    ? groups.sort(
        (a, b) =>
          b.score - a.score ||
          COMMAND_GROUPS.indexOf(a.id) - COMMAND_GROUPS.indexOf(b.id)
      )
    : groups;
};

/** Mark the matched subsequence without injecting HTML into user titles. */
export const highlightCommand = (title: string, query: string) => {
  const search = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
  let cursor = 0;
  return [...title].map((text) => {
    const matched =
      cursor < search.length && text.toLocaleLowerCase() === search[cursor];
    if (matched) cursor++;
    return { text, matched };
  });
};
