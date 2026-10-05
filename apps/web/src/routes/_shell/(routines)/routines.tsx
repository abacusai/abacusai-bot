import { createFileRoute, Outlet } from "@tanstack/react-router";

import { unlessConnecting } from "#renderer/features/onboarding/gate";

export const Route = createFileRoute("/_shell/(routines)/routines")({
  staticData: { area: "routines", sidebar: "routines" },
  loader: async ({ context }) => {
    // Auto-replies and sender chats are sidebar extras that fill in.
    void context.queryClient.prefetchQuery(
      context.transport.orpc.messaging.snapshot.queryOptions({ input: {} })
    );
    void context.queryClient.prefetchQuery(
      context.transport.orpc.bots.senderChats.queryOptions({ input: {} })
    );
    await unlessConnecting(
      context.transport,
      Promise.all([
        context.db.collections.routines.preload(),
        context.db.collections.routineRuns.preload(),
        context.db.collections.bots.preload(),
      ])
    );
  },
  component: Outlet,
});
