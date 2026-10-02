import { createFileRoute } from "@tanstack/react-router";

import { KeyboardPage } from "#next/features/settings";
export const Route = createFileRoute("/_shell/settings/keyboard")({
  component: KeyboardPage,
});
