/**
 * Which view-transition type a committed navigation plays (spec 01 §6.7).
 * Pure: `inferNavType` takes where the pane was, where it goes, the history
 * direction and the entry's intent. Rules, first match wins:
 *
 * 1. Same pane key (a pop-up opening or closing over its background, a
 *    search-only change) → none.
 * 2. Back in history → `nav-back`. Forward to an entry committed before →
 *    inference (rule 4), never the entry's saved intent.
 * 3. A new entry's explicit intent.
 * 4. Inference from ROUTE_RANK: into settings `settings-in`, out of it
 *    `settings-out`; another area `nav-lateral`; same area, deeper
 *    `nav-forward`, shallower `nav-back`, equal `nav-lateral`.
 */
import type { NavType } from "#next/lib/motion";

export type RouteArea =
  | "bots"
  | "sessions"
  | "routines"
  | "artifacts"
  | "library"
  | "settings"
  | "onboarding"
  | "gallery"
  | "root";

/**
 * Every leaf route's place in its area, by full path without a trailing
 * slash. Rank 0: the area's root, list or "new"; 1: an entity; 2: a
 * sub-page of an entity. A test keeps it in step with the route tree.
 */
export const ROUTE_RANK: Readonly<
  Record<string, { area: RouteArea; rank: number }>
> = {
  "": { area: "root", rank: 0 },
  "/bots": { area: "bots", rank: 0 },
  "/bots/new": { area: "bots", rank: 0 },
  "/bots/$botId": { area: "bots", rank: 1 },
  "/bots/$botId/details": { area: "bots", rank: 1 },
  "/bots/$botId/edit": { area: "bots", rank: 2 },
  "/sessions": { area: "sessions", rank: 0 },
  "/sessions/new": { area: "sessions", rank: 0 },
  "/sessions/$sessionId": { area: "sessions", rank: 1 },
  "/sessions/$sessionId/review": { area: "sessions", rank: 2 },
  "/routines": { area: "routines", rank: 0 },
  "/routines/new": { area: "routines", rank: 0 },
  "/routines/$routineId": { area: "routines", rank: 1 },
  "/artifacts": { area: "artifacts", rank: 0 },
  "/library": { area: "library", rank: 0 },
  "/library/connectors": { area: "library", rank: 0 },
  "/library/messaging": { area: "library", rank: 0 },
  "/library/mcp": { area: "library", rank: 0 },
  "/library/skills": { area: "library", rank: 0 },
  "/library/tools": { area: "library", rank: 0 },
  "/library/tools/$toolsetId": { area: "library", rank: 1 },
  "/settings": { area: "settings", rank: 0 },
  "/settings/general": { area: "settings", rank: 0 },
  "/settings/appearance": { area: "settings", rank: 0 },
  "/settings/notifications": { area: "settings", rank: 0 },
  "/settings/memory": { area: "settings", rank: 0 },
  "/settings/usage": { area: "settings", rank: 0 },
  "/settings/account": { area: "settings", rank: 0 },
  "/settings/models": { area: "settings", rank: 0 },
  "/settings/environment": { area: "settings", rank: 0 },
  "/settings/about": { area: "settings", rank: 0 },
  "/onboarding": { area: "onboarding", rank: 0 },
  "/onboarding/$step": { area: "onboarding", rank: 0 },
  "/__ui": { area: "gallery", rank: 0 },
};

const normalizeFullPath = (fullPath: string): string =>
  fullPath.replace(/\/+$/, "");

const rankOf = (fullPath: string): { area: RouteArea; rank: number } =>
  ROUTE_RANK[normalizeFullPath(fullPath)] ?? { area: "root", rank: 0 };

export interface PaneLocation {
  /** The leaf route's full path (`/bots/$botId`). */
  fullPath: string;
  paneKey: string;
}

export type HistoryDirection = "new" | "back" | "forward-seen";

export const inferNavType = (
  from: PaneLocation | null,
  to: PaneLocation,
  direction: HistoryDirection,
  intent?: NavType | "none"
): NavType | null => {
  if (from == null) return null;
  if (from.paneKey === to.paneKey) return null;
  if (direction === "back") return "nav-back";
  if (direction === "new" && intent !== undefined)
    return intent === "none" ? null : intent;

  const a = rankOf(from.fullPath);
  const b = rankOf(to.fullPath);
  if (b.area === "settings" && a.area !== "settings") return "settings-in";
  if (a.area === "settings" && b.area !== "settings") return "settings-out";
  if (a.area !== b.area) return "nav-lateral";
  if (b.rank > a.rank) return "nav-forward";
  if (b.rank < a.rank) return "nav-back";
  return "nav-lateral";
};
