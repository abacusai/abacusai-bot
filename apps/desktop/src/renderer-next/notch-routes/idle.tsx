import { createFileRoute } from "@tanstack/react-router";

import { IdleView } from "#next/features/notch";
export const Route = createFileRoute("/idle")({ component: IdleView });
