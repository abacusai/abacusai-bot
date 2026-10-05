import {
  createFileRoute,
  Outlet,
  retainSearchParams,
} from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(sessions)/sessions")({
  staticData: { area: "sessions", sidebar: "sessions" },
  // `view` belongs to the child routes' search, not this layout's.
  search: { middlewares: [retainSearchParams(["view"] as never)] },
  component: Outlet,
});
