import { createFileRoute } from "@tanstack/react-router";

import { BrowserPage } from "#next/features/settings";
export const Route = createFileRoute("/_shell/settings/browser")({
  component: BrowserPage,
});
