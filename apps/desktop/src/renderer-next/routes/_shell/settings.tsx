import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Settings take over the sidebar slot (canvas `SettingsInPlace`). */
export const Route = createFileRoute("/_shell/settings")({
  staticData: { area: "settings", sidebar: "settings" },
  component: Outlet,
});
