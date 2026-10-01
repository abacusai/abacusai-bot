import { createFileRoute } from "@tanstack/react-router";

import { LanguagePage } from "#next/features/settings";
export const Route = createFileRoute("/_shell/settings/language")({
  component: LanguagePage,
});
