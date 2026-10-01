import { createFileRoute } from "@tanstack/react-router";

import { DevicesPage } from "#renderer/features/settings";
export const Route = createFileRoute("/_shell/settings/devices")({
  component: DevicesPage,
});
