import { createFileRoute } from "@tanstack/react-router";

import { BareLayout } from "#renderer/features/shell/screens";

/** No chrome: a drag strip and the page. Readiness is reported by the root. */
export const Route = createFileRoute("/_bare")({
  component: BareLayout,
});
