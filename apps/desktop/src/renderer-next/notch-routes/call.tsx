import { createFileRoute } from "@tanstack/react-router";

import { CallView } from "#next/features/notch";
export const Route = createFileRoute("/call")({ component: CallView });
