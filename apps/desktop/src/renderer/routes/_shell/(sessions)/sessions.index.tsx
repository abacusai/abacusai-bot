import { createFileRoute, redirect } from "@tanstack/react-router";

import { isListedSession } from "#renderer/data/db/filters";
import { shellStore } from "#renderer/features/shell/shell-store";
export const Route = createFileRoute("/_shell/(sessions)/sessions/")({
  loader: async ({ context, preload }) => {
    await Promise.all([
      context.db.collections.sessions.preload(),
      context.db.collections.workspaces.preload(),
    ]);
    if (preload) return;
    const saved = shellStore.state.lastLocationByArea.sessions?.pathname;
    if (saved?.startsWith("/sessions/") && saved !== "/sessions/new") {
      const id = saved.split("/")[2]?.split("?")[0];
      const row = id ? context.db.collections.sessions.get(id) : undefined;
      if (row && isListedSession(row))
        throw redirect({
          to: "/sessions/$sessionId",
          params: { sessionId: row.id },
          replace: true,
        });
    }
    throw redirect({ to: "/sessions/new", replace: true });
  },
});
