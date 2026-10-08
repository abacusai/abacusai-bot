export const TOUR_STOPS = [
  { id: "sessions", target: "sessions" },
  { id: "settings", target: "settings" },
  { id: "connectors", target: "library" },
  { id: "bots", target: "bots" },
] as const;
export type TourStop = (typeof TOUR_STOPS)[number];
