import { createFileRoute, notFound } from "@tanstack/react-router";

import { BrowserPage } from "#renderer/features/settings/environment";
import { IS_ELECTRON } from "#renderer/lib/platform";
export const Route = createFileRoute("/_shell/settings/browser")({
  beforeLoad: () => {
    if (!IS_ELECTRON) throw notFound();
  },
  component: BrowserPage,
});
