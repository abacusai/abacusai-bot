import {
  createFileRoute,
  Outlet,
  redirect,
  retainSearchParams,
} from "@tanstack/react-router";

import { isRunnerView, isWebApp } from "#renderer/lib/web-app";

export const Route = createFileRoute("/_shell/(sessions)/sessions")({
  staticData: { area: "sessions", sidebar: "sessions" },
  search: { middlewares: [retainSearchParams(["view"] as never)] },
  // The web app's own server does no coding; the coding view (served by the
  // user's desktop) does, and the web app points there.
  beforeLoad: () => {
    if (isWebApp && !isRunnerView())
      throw redirect({ to: "/coding", replace: true });
  },
  component: Outlet,
});
