import { createFileRoute, notFound } from "@tanstack/react-router";

import { resolveToolDiff } from "#next/features/chat";
import {
  FullDiffDialog,
  useSession,
  useWorkspace,
} from "#next/features/sessions";
import { DiffSearch } from "#next/lib/navigation/search";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";

import { sessionRuntime } from "./-runtime";
const SessionDiffRoute = () => {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  const { transport } = Route.useRouteContext();
  const row = useSession(sessionId);
  const workspace = useWorkspace(row?.workspaceId ?? "");
  const navigate = useAppNavigate();
  if (!row) return null;
  const close = () => {
    const {
      path: _path,
      source: _source,
      toolKey: _key,
      mode: _mode,
      ...rest
    } = search;
    void navigate({
      to: "/sessions/$sessionId",
      params: { sessionId },
      search: rest,
      replace: true,
      transition: "none",
    });
  };
  return (
    <FullDiffDialog
      sessionId={sessionId}
      workspaceId={row.workspaceId}
      root={row.worktreePath ?? workspace?.path ?? ""}
      path={search.path}
      scope={search.scope}
      source={search.source}
      mode={search.mode}
      resolveTool={() =>
        search.toolKey
          ? resolveToolDiff(
              sessionRuntime(transport, sessionId).session(sessionId),
              search.toolKey
            )
          : Promise.resolve({ state: "unavailable" })
      }
      onClose={close}
      onGit={() =>
        void navigate({
          to: ".",
          search: (p) => ({ ...p, source: "git" }),
          replace: true,
          transition: "none",
        })
      }
    />
  );
};
export const Route = createFileRoute(
  "/_shell/(sessions)/sessions/$sessionId/diff"
)({
  validateSearch: DiffSearch,
  loader: async ({ context, params }) => {
    await Promise.all([
      context.db.collections.sessions.preload(),
      context.db.collections.workspaces.preload(),
    ]);
    if (!context.db.collections.sessions.has(params.sessionId))
      throw notFound();
  },
  component: SessionDiffRoute,
});
