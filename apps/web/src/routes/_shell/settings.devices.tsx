import { createFileRoute, notFound } from "@tanstack/react-router";

import { DevicesPage } from "#renderer/features/settings/environment";
import { IS_ELECTRON } from "#renderer/lib/platform";
export const Route = createFileRoute("/_shell/settings/devices")({
  beforeLoad: () => {
    if (!IS_ELECTRON) throw notFound();
  },
  component: DevicesPage,
});
