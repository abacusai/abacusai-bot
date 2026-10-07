import type { TourAnchorId } from "#renderer/lib/tour/anchors";
import type { FileRoutesByTo } from "#renderer/routeTree.gen";
export interface TourStop {
  id: string;
  anchor: TourAnchorId | null;
  to?: Extract<
    keyof FileRoutesByTo,
    | "/bots/new"
    | "/sessions/new"
    | "/library/connectors"
    | "/settings/memory"
    | "/artifacts"
  >;
  optional?: true;
}
export const TOUR_STOPS: readonly TourStop[] = [
  { id: "welcome", anchor: null },
  { id: "rail", anchor: "rail-bots-sessions", to: "/bots/new" },
  { id: "make-bot", anchor: "bots-name-input", to: "/bots/new" },
  { id: "workspaces", anchor: "sessions-sidebar", to: "/sessions/new" },
  {
    id: "start-session",
    anchor: "new-session-composer",
    to: "/sessions/new",
  },
  {
    id: "connectors",
    anchor: "library-connectors",
    to: "/library/connectors",
  },
  { id: "talk", anchor: "composer" },
  { id: "changes", anchor: "panel-changes" },
  { id: "preview-terminal", anchor: "topbar-panel-tabs", optional: true },
  { id: "memory", anchor: "settings-memory", to: "/settings/memory" },
  { id: "artifacts", anchor: "rail-artifacts", to: "/artifacts" },
  { id: "notch", anchor: null },
];
