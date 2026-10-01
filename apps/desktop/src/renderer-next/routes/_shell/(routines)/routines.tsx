import { createFileRoute, Outlet } from "@tanstack/react-router";
export const Route = createFileRoute("/_shell/(routines)/routines")({
  staticData: { area: "routines", sidebar: "routines" },
  loader: async ({ context }) => {
    await Promise.all([
      context.db.collections.routines.preload(),
      context.db.collections.routineRuns.preload(),
      context.db.collections.bots.preload(),
      context.queryClient.ensureQueryData(
        context.transport.orpc.messaging.snapshot.queryOptions({ input: {} })
      ),
      context.queryClient.ensureQueryData(
        context.transport.orpc.bots.senderChats.queryOptions({ input: {} })
      ),
    ]);
  },
  component: Outlet,
});
