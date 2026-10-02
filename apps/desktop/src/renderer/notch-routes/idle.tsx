import { createFileRoute } from "@tanstack/react-router";

import { IdleView } from "#renderer/features/notch";
export const Route = createFileRoute("/idle")({ component: IdleView });
