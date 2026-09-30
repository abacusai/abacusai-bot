import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useRouter } from "@tanstack/react-router";

import { useCollections } from "#next/data/db";
import { isListedSession } from "#next/data/db/filters";
import type { Transport } from "#next/data/transport";
import type { AppQueryUtils } from "#next/data/transport/types";
import { checkoutKey, type CheckoutRef } from "#shared/contract/checkout";
import type { WorkspaceRow } from "#shared/contract/rows";

export const useSessionsTransport = (): Transport =>
  useRouter().options.context.transport;
export const isPickableWorkspace = (w: WorkspaceRow): boolean =>
  w.status !== "deleted" && (w.kind == null || w.kind === "auto");
export const useSession = (id: string) => {
  const c = useCollections();
  return useLiveQuery(
    (q) =>
      q
        .from({ s: c.sessions })
        .where(({ s }) => eq(s.id, id))
        .findOne(),
    [id]
  ).data;
};
export const useWorkspace = (id: string) => {
  const c = useCollections();
  return useLiveQuery(
    (q) =>
      q
        .from({ w: c.workspaces })
        .where(({ w }) => eq(w.id, id))
        .findOne(),
    [id]
  ).data;
};
export const useListedSessions = () => {
  const c = useCollections();
  return (useLiveQuery(c.sessions).data ?? []).filter(isListedSession);
};
export const usePickableWorkspaces = () => {
  const c = useCollections();
  return (useLiveQuery(c.workspaces).data ?? []).filter(isPickableWorkspace);
};
export const useGitState = (checkout: CheckoutRef) => {
  const c = useCollections();
  const session = useSession(checkout.sessionId ?? "");
  const key = checkoutKey(checkout.workspaceId, session?.worktreeId);
  return useLiveQuery(
    (q) =>
      q
        .from({ g: c.gitState })
        .where(({ g }) => eq(g.checkoutKey, key))
        .findOne(),
    [key]
  ).data;
};
export const sessionsQueries = (orpc: AppQueryUtils) => ({
  checkoutStatus: (checkout: CheckoutRef) =>
    orpc.git.checkoutStatus.queryOptions({
      input: { checkout },
      refetchOnWindowFocus: true,
    }),
  tree: (checkout: CheckoutRef) =>
    orpc.files.treeRoot.queryOptions({ input: { checkout } }),
  children: (checkout: CheckoutRef, directoryPath: string) =>
    orpc.files.treeChildren.queryOptions({
      input: { checkout, directoryPath },
    }),
  search: (checkout: CheckoutRef, query: string) =>
    orpc.files.search.queryOptions({
      input: { checkout, query },
      staleTime: 5000,
    }),
  branches: (checkout: CheckoutRef) =>
    orpc.git.branches.queryOptions({ input: checkout, staleTime: 5000 }),
  branch: (checkout: CheckoutRef) =>
    orpc.git.currentBranch.queryOptions({ input: checkout, staleTime: 5000 }),
  pr: (checkout: CheckoutRef) =>
    orpc.git.prInfo.queryOptions({
      input: checkout,
      refetchInterval: 60000,
      refetchOnWindowFocus: true,
    }),
  worktrees: (workspaceId: string) =>
    orpc.git.worktrees.list.queryOptions({ input: { workspaceId } }),
  diff: (
    checkout: CheckoutRef,
    path: string,
    scope: "staged" | "unstaged",
    fingerprint?: string
  ) => ({
    ...orpc.git.diff.queryOptions({
      input: { checkout, filePath: path, scope },
    }),
    queryKey: [
      ...orpc.git.diff.key({ input: { checkout, filePath: path, scope } }),
      fingerprint,
    ],
  }),
  exec: () => orpc.settings.execBackend.get.queryOptions({ input: {} }),
  sandbox: () => orpc.settings.sandboxSupport.queryOptions({ input: {} }),
  models: () => orpc.models.list.queryOptions({ input: {} }),
  settings: () => orpc.settings.get.queryOptions({ input: {} }),
});
