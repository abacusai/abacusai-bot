import { createFileRoute } from "@tanstack/react-router";

import { KeyboardPage } from "#renderer/features/settings/keyboard";
export const Route = createFileRoute("/_shell/settings/keyboard")({
  component: KeyboardPage,
});
