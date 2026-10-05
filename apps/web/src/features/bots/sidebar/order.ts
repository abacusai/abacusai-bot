import type { BotRow } from "@abacus-ai/contract/contract/rows";
/**
 * The sidebar's order (spec 03 §7.2): one flat list of label and bot entries
 * under one keyed parent, so a bot that moves between groups keeps its row.
 * Needs you (oldest waiting first) → Pinned (pin order) → the rest by last
 * activity. With a search query: one flat filtered list, no labels.
 */
import type { BotChatPreview } from "@abacus-ai/contract/contracts";

import type { BotAttention } from "../data/attention";

type SidebarGroup = "needs-you" | "pinned" | "rest";

export type SidebarEntry =
  | {
      kind: "label";
      key: `label:${"needs-you" | "pinned"}`;
      group: SidebarGroup;
    }
  | { kind: "bot"; key: string; bot: BotRow; group: SidebarGroup };

/** Case- and accent-insensitive (`sensitivity: "base"` on normalised text). */
const matchesQuery = (
  bot: Pick<BotRow, "name" | "title">,
  query: string
): boolean => {
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase();
  const needle = fold(query.trim());
  if (needle === "") return true;
  return fold(bot.name).includes(needle) || fold(bot.title).includes(needle);
};

const lastActivity = (
  bot: BotRow,
  previews: Readonly<Record<string, BotChatPreview>>
): number => previews[bot.id]?.at ?? bot.updatedAt;

export const sidebarEntries = (input: {
  bots: readonly BotRow[];
  pinnedIds: readonly string[];
  attention: ReadonlyMap<string, BotAttention>;
  previews: Readonly<Record<string, BotChatPreview>>;
  query?: string;
}): SidebarEntry[] => {
  const byActivity = (a: BotRow, b: BotRow) =>
    lastActivity(b, input.previews) - lastActivity(a, input.previews);
  const query = input.query?.trim() ?? "";
  if (query !== "")
    return input.bots
      .filter((bot) => matchesQuery(bot, query))
      .toSorted(byActivity)
      .map((bot) => ({ kind: "bot", key: bot.id, bot, group: "rest" }));

  const needsYou = input.bots
    .filter((bot) => input.attention.get(bot.id)?.kind === "needs-you")
    .toSorted((a, b) => {
      const since = (bot: BotRow) => {
        const attention = input.attention.get(bot.id);
        return attention?.kind === "needs-you" ? attention.since : 0;
      };
      return since(a) - since(b);
    });
  const needing = new Set(needsYou.map((bot) => bot.id));
  const pinned = input.pinnedIds
    .map((id) => input.bots.find((bot) => bot.id === id))
    .filter((bot): bot is BotRow => bot != null && !needing.has(bot.id));
  const pinnedSet = new Set(input.pinnedIds);
  const rest = input.bots
    .filter((bot) => !needing.has(bot.id) && !pinnedSet.has(bot.id))
    .toSorted(byActivity);

  const entries: SidebarEntry[] = [];
  if (needsYou.length > 0) {
    entries.push({ kind: "label", key: "label:needs-you", group: "needs-you" });
    for (const bot of needsYou)
      entries.push({ kind: "bot", key: bot.id, bot, group: "needs-you" });
  }
  if (pinned.length > 0) {
    entries.push({ kind: "label", key: "label:pinned", group: "pinned" });
    for (const bot of pinned)
      entries.push({ kind: "bot", key: bot.id, bot, group: "pinned" });
  }
  for (const bot of rest)
    entries.push({ kind: "bot", key: bot.id, bot, group: "rest" });
  return entries;
};

/** The strip's order: needs-you, then pinned, then the rest (§7.7). */
export const stripOrder = (entries: readonly SidebarEntry[]): BotRow[] =>
  entries.flatMap((entry) => (entry.kind === "bot" ? [entry.bot] : []));
