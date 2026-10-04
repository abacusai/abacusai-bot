import { createFileRoute, redirect } from "@tanstack/react-router";

import { CodingPage } from "#renderer/features/web";
import { isWebApp } from "#renderer/lib/web-app";

/** The hosted web app's Sessions: coding runs on the user's computer. */
export const Route = createFileRoute("/_shell/(sessions)/coding")({
  staticData: { area: "sessions", sidebar: "sessions" },
  beforeLoad: () => {
    if (!isWebApp) throw redirect({ to: "/sessions", replace: true });
  },
  component: CodingPage,
});
