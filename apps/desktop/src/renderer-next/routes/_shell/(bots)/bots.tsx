import { createFileRoute, Outlet } from "@tanstack/react-router";
import { LayoutGroup } from "motion/react";

import { botsQueries } from "#next/features/bots";
const BotsLayout = () => (
  <LayoutGroup id="bots">
    <Outlet />
  </LayoutGroup>
);
export const Route = createFileRoute("/_shell/(bots)/bots")({
  staticData: { area: "bots", sidebar: "bots" },
  loader: async ({ context }) => {
    await Promise.all([
      context.db.collections.bots.preload(),
      context.db.collections.routines.preload(),
      context.queryClient.ensureQueryData(
        botsQueries(context.transport.orpc).chatPreviews()
      ),
    ]);
  },
  component: BotsLayout,
});
