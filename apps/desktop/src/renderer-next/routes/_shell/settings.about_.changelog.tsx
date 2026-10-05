import { createFileRoute } from "@tanstack/react-router";

import { ChangelogPage } from "#next/features/settings";
export const Route = createFileRoute("/_shell/settings/about_/changelog")({
  component: ChangelogPage,
});
