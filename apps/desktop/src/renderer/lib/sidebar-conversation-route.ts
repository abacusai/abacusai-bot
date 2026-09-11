import { useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";

export type SidebarConversationRoute = {
  kind: "bot" | "session" | "routine";
  id: string;
};

export const sidebarConversationRoute = (
  pathname: string
): SidebarConversationRoute | null => {
  const match = pathname.match(
    /^\/(bots|sessions|routines)\/([^/]+)(?:\/edit)?\/?$/
  );
  if (match == null) return null;

  const family = match[1];
  const encodedId = match[2];
  if (family == null || encodedId == null || encodedId === "new") return null;

  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return null;
  }

  return {
    kind:
      family === "bots" ? "bot" : family === "routines" ? "routine" : "session",
    id,
  };
};

export const useSidebarConversationRoute =
  (): SidebarConversationRoute | null => {
    const pathname = useRouterState({
      select: (state) => state.location.pathname,
    });
    return useMemo(() => sidebarConversationRoute(pathname), [pathname]);
  };
