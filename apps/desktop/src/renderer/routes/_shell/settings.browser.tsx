import { createFileRoute } from "@tanstack/react-router";

import { BrowserPage } from "#renderer/features/settings";
export const Route = createFileRoute("/_shell/settings/browser")({
  component: BrowserPage,
});
