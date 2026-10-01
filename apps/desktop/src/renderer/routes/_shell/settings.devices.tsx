import { createFileRoute } from "@tanstack/react-router";

import { DevicesPage } from "#renderer/features/settings/environment";
export const Route = createFileRoute("/_shell/settings/devices")({
  component: DevicesPage,
});
