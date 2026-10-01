import { createFileRoute } from "@tanstack/react-router";

import { CompactView } from "#renderer/features/notch";
export const Route = createFileRoute("/failed")({ component: CompactView });
