/**
 * After a replaced socket (spec 09 D3): the query families that a host
 * notice keeps fresh, refetched once per recovery. Their notices (settings,
 * credentials, connectors, models, account, messaging, file trees, …)
 * carry no snapshot and are not replayed, so one sent while no socket was
 * open is lost; the notice streams reopen on their own (`followNotices`).
 * Only active queries refetch. Everything else is left to its own
 * staleness: diffs and chat transcripts are fetched per view, and
 * collections re-sync through their `hello`. The signed-in answer is one of these families, so invalidating
 * it also re-runs the sign-in gate before held writes go out
 * (`followWriteAuthorization`).
 *
 * A link that flaps opens several sockets in a row: recoveries never
 * overlap, and those asked for meanwhile run once, after.
 */
import type { QueryClient } from "@tanstack/react-query";

import { untilOpen } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";

/** First path segment of the queries a lost notice would have refreshed. */
export const MISSED_NOTICE_FAMILIES: ReadonlySet<string> = new Set([
  "account",
  "bots",
  "browser",
  "connectors",
  "devices",
  "files",
  "localModels",
  "mcp",
  "memory",
  "messaging",
  "models",
  "settings",
  "skills",
  "system",
]);

/** An oRPC query key starts with its procedure path: `[["account", "state"], …]`. */
const familyOf = (queryKey: readonly unknown[]): string | undefined => {
  const path = queryKey[0];
  return Array.isArray(path) && typeof path[0] === "string"
    ? path[0]
    : undefined;
};

/** Refetches the missed-notice families on each replacement socket. */
export const followReconnects = (
  transport: Pick<Transport, "state" | "generation" | "onChange">,
  queryClient: QueryClient
): (() => void) => {
  let seen = transport.generation;
  let running = false;
  let again = false;
  const recover = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (!(await untilOpen(transport))) return;
        await queryClient
          .invalidateQueries({
            predicate: (query) =>
              MISSED_NOTICE_FAMILIES.has(familyOf(query.queryKey) ?? ""),
          })
          .catch(() => undefined);
      } while (again);
    } finally {
      running = false;
    }
  };
  return transport.onChange(() => {
    if (transport.state !== "open" || transport.generation === seen) return;
    const replaced = seen > 0;
    seen = transport.generation;
    if (replaced) void recover();
  });
};
