import { createFileRoute } from "@tanstack/react-router";

import { CompactView } from "#renderer/features/notch";
export const Route = createFileRoute("/done")({ component: CompactView });
