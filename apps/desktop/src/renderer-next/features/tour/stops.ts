import type { TourAnchorId } from "#next/lib/tour/anchors";
export interface TourStop {
  id: string;
  anchor: TourAnchorId | null;
  href?: string;
  optional?: true;
}
export const TOUR_STOPS: readonly TourStop[] = [
  { id: "welcome", anchor: null },
  { id: "rail", anchor: "rail-bots-sessions", href: "/bots/new" },
  { id: "make-bot", anchor: "bots-name-input", href: "/bots/new" },
  { id: "workspaces", anchor: "sessions-sidebar", href: "/sessions/new" },
  {
    id: "start-session",
    anchor: "new-session-composer",
    href: "/sessions/new",
  },
  {
    id: "connectors",
    anchor: "library-connectors",
    href: "/library/connectors",
  },
  { id: "talk", anchor: "composer" },
  { id: "changes", anchor: "panel-changes" },
  { id: "preview-terminal", anchor: "topbar-panel-tabs", optional: true },
  { id: "memory", anchor: "settings-memory", href: "/settings/memory" },
  { id: "artifacts", anchor: "rail-artifacts", href: "/artifacts" },
  { id: "notch", anchor: null },
];
