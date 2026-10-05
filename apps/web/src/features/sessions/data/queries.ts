import {
  checkoutKey,
  type CheckoutRef,
} from "@abacus-ai/contract/contract/checkout";
import type {
  WorkspaceRow,
  SessionRow,
} from "@abacus-ai/contract/contract/rows";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { useCollections } from "#renderer/data/db";
import { followNotices } from "#renderer/data/queries/live";
import type { Transport } from "#renderer/data/transport";
import type { AppQueryUtils } from "#renderer/data/transport/types";

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
export const effectiveCheckoutIdentity = (
  workspaceId: string,
  session?: Pick<SessionRow, "worktreeId" | "worktreePath">,
  workspacePath?: string
) =>
  `${checkoutKey(workspaceId, session?.worktreeId)}:${session?.worktreePath ?? workspacePath ?? ""}`;
export const useCheckoutIdentity = (checkout: CheckoutRef) => {
  const session = useSession(checkout.sessionId ?? "");
  const workspace = useWorkspace(checkout.workspaceId);
  return effectiveCheckoutIdentity(
    checkout.workspaceId,
    session,
    workspace?.path
  );
};
/**
 * Keeps the host watching this checkout while the view is mounted. The
 * watch lives as long as its stream, so it is reopened on every new socket
 * (`followNotices`) until this checkout's view goes away.
 */
const watchCheckout = (
  transport: Transport,
  workspaceId: string,
  sessionId: string | undefined,
  signal: AbortSignal
) =>
  followNotices(
    transport,
    ({ signal }) =>
      transport.client.git.watch(
        { checkout: { workspaceId, ...(sessionId ? { sessionId } : {}) } },
        { signal }
      ),
    () => undefined,
    signal
  );

export const useCheckoutWatch = (
  transport: Transport,
  checkout: CheckoutRef,
  identity: string
) => {
  const { workspaceId, sessionId } = checkout;
  useEffect(() => {
    const abort = new AbortController();
    void watchCheckout(transport, workspaceId, sessionId, abort.signal);
    return () => abort.abort();
  }, [transport, workspaceId, sessionId, identity]);
};
export const useCheckoutQueries = (checkout: CheckoutRef) => {
  const transport = useSessionsTransport();
  return sessionsQueries(transport.orpc, useCheckoutIdentity(checkout));
};
export const sessionsQueries = (orpc: AppQueryUtils, identity?: string) => {
  const scoped = <T extends { queryKey: readonly unknown[] }>(options: T): T =>
    identity === undefined
      ? options
      : { ...options, queryKey: [...options.queryKey, identity] };
  return {
    checkoutStatus: (checkout: CheckoutRef) =>
      scoped(
        orpc.git.checkoutStatus.queryOptions({
          input: { checkout },
          refetchOnWindowFocus: true,
        })
      ),
    tree: (checkout: CheckoutRef) =>
      scoped(orpc.files.treeRoot.queryOptions({ input: { checkout } })),
    children: (checkout: CheckoutRef, directoryPath: string) =>
      scoped(
        orpc.files.treeChildren.queryOptions({
          input: { checkout, directoryPath },
        })
      ),
    search: (checkout: CheckoutRef, query: string) =>
      scoped(
        orpc.files.search.queryOptions({
          input: { checkout, query },
          staleTime: 5000,
        })
      ),
    branches: (checkout: CheckoutRef) =>
      scoped(
        orpc.git.branches.queryOptions({ input: checkout, staleTime: 5000 })
      ),
    branch: (checkout: CheckoutRef) =>
      scoped(
        orpc.git.currentBranch.queryOptions({
          input: checkout,
          staleTime: 5000,
        })
      ),
    pr: (checkout: CheckoutRef) =>
      scoped(
        orpc.git.prInfo.queryOptions({
          input: checkout,
          refetchInterval: 60000,
          refetchOnWindowFocus: true,
        })
      ),
    worktrees: (workspaceId: string) =>
      orpc.git.worktrees.list.queryOptions({ input: { workspaceId } }),
    diff: (
      checkout: CheckoutRef,
      path: string,
      scope: "staged" | "unstaged",
      fingerprint?: string
    ) =>
      scoped({
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
    // Fresh for five minutes, as the bots catalog (features/bots/data/queries).
    models: () =>
      orpc.models.list.queryOptions({ input: {}, staleTime: 5 * 60_000 }),
    settings: () => orpc.settings.get.queryOptions({ input: {} }),
  };
};
