import { createFileRoute } from "@tanstack/react-router";

import { DevicesPage } from "#next/features/settings";
export const Route = createFileRoute("/_shell/settings/devices")({
  component: DevicesPage,
});
