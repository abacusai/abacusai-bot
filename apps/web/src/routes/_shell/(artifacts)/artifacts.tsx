import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(artifacts)/artifacts")({
  staticData: { area: "artifacts", sidebar: "artifacts" },
  component: Outlet,
});
