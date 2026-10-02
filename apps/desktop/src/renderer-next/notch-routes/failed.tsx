import { createFileRoute } from "@tanstack/react-router";

import { CompactView } from "#next/features/notch";
export const Route = createFileRoute("/failed")({ component: CompactView });
