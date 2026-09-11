import { useMatches } from "@tanstack/react-router";

export type WorkspaceRouteKind = "session" | "bot" | "settings";

/**
 * Page behavior comes from the matched route family, not from the current
 * Zustand selection. This keeps bot chrome correct while an old
 * session is still selected behind the page.
 */
export const useWorkspaceRouteKind = (): WorkspaceRouteKind =>
  useMatches({
    select: (matches) =>
      ([...matches]
        .reverse()
        .map(
          (match) =>
            (match.staticData as { workspaceKind?: WorkspaceRouteKind })
              .workspaceKind
        )
        .find((kind) => kind != null) ?? "settings") as WorkspaceRouteKind,
  });
