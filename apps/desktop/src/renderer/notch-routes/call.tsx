import { createFileRoute } from "@tanstack/react-router";

import { CallView } from "#renderer/features/notch";
export const Route = createFileRoute("/call")({ component: CallView });
