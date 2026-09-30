export const TOUR_ANCHORS = [
  "rail-bots-sessions",
  "bots-name-input",
  "sessions-sidebar",
  "new-session-composer",
  "rail-library",
  "library-connectors",
  "composer",
  "panel-changes",
  "topbar-panel-tabs",
  "settings-memory",
  "rail-artifacts",
] as const;
export type TourAnchorId = (typeof TOUR_ANCHORS)[number];
export const tourAnchor = (
  id: TourAnchorId
): { "data-tour": TourAnchorId } => ({ "data-tour": id });
