import type { AccountState } from "@abacus-ai/contract/account";
import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
/**
 * The sign-in gate both route trees share (spec 09 D12). Signed in and
 * onboarded are known only from the host. While the browser's host is still
 * connecting, a route renders provisionally when the user's last-known flags
 * agree with it (the shell for an onboarded, signed-in user; onboarding
 * otherwise); every other case waits for the host. No redirect is ever taken
 * from remembered flags: the provisional route re-runs its gate once the
 * host answers, and redirects then if it must. Writes stay held by the
 * transport until a gate decided from fresh state keeps the route; a gate
 * that leaves revokes them, and the browser suspends them again whenever
 * the signed-in answer is invalidated (`followWriteAuthorization`).
 */
import { hashKey, type QueryClient } from "@tanstack/react-query";

import { readLastKnown, writeLastKnown } from "#platform/last-known";
import { untilOpen } from "#renderer/data/queries/live";
import type { Transport } from "#renderer/data/transport";

import { accountStateQuery, signedInQuery } from "./actions";
import { needsOnboarding } from "./machine";

export interface GateContext {
  queryClient: QueryClient;
  transport: Transport;
}

interface GateFlags {
  onboarded: boolean;
  signedIn: boolean;
}

export interface FreshGate {
  /** Taken when the check started: `keep()` confirms only with it. */
  ticket: number;
  account: AccountState;
  /** `false` too when onboarding never asked (the account is not onboarded). */
  signedIn: boolean;
}

type GateRoute = "shell" | "onboarding";

const belongsIn = (flags: GateFlags): GateRoute =>
  needsOnboarding(
    { onboarded: flags.onboarded } as AccountState,
    flags.signedIn
  )
    ? "onboarding"
    : "shell";

/**
 * The host's answer, cached by the query client; remembered per user.
 * Onboarding asks for the settings only of an onboarded account: one that
 * is not stays in onboarding whatever they say, also when they fail.
 */
const freshGate = async (
  { queryClient, transport }: GateContext,
  route: GateRoute
): Promise<FreshGate> => {
  const ticket = transport.writeTicket();
  // `fetchQuery`: never stale by time, but an invalidated answer (a
  // replaced socket, a credentials notice) is asked again even when no
  // component observes it.
  const account = await queryClient.fetchQuery(accountStateQuery(transport));
  const signedIn =
    route === "onboarding" && !account.onboarded
      ? false
      : canSignOutOfAbacus(
          await queryClient.fetchQuery(signedInQuery(transport))
        );
  writeLastKnown("gate", { onboarded: account.onboarded, signedIn });
  return { ticket, account, signedIn };
};

/** The host already answered on this page (and no sign-in change since). */
const answered = ({ queryClient, transport }: GateContext): boolean => {
  const settings = queryClient.getQueryState(signedInQuery(transport).queryKey);
  return (
    queryClient.getQueryData(accountStateQuery(transport).queryKey) != null &&
    settings?.status === "success" &&
    !settings.isInvalidated
  );
};

let provisional = false;

/**
 * Fresh state, or `null` when `route` may render provisionally. Callers
 * redirect on fresh state only, and call `keep()` or `leave()` with it.
 */
export const readGate = (
  context: GateContext,
  route: GateRoute
): Promise<FreshGate> | null => {
  if (context.transport.state !== "open" && !answered(context)) {
    const last = readLastKnown<GateFlags>("gate");
    if (last != null && belongsIn(last) === route) {
      provisional = true;
      return null;
    }
  }
  return freshGate(context, route);
};

/**
 * The gate kept the route: release the writes held since boot (or since
 * the last suspension). The shell, once kept, ends any remembered
 * destination: onboarding is over, or was never needed.
 */
export const keep = (
  context: GateContext,
  route: GateRoute,
  gate: Pick<FreshGate, "ticket">
): void => {
  provisional = false;
  if (route === "shell") writeLastKnown("destination", null);
  context.transport.confirmWrites(gate.ticket);
};

/**
 * The gate is leaving the route: the writes made on it are never sent, and
 * new ones wait for the next route's gate. A late redirect away from a
 * provisional render remembers, for this user, where they were going
 * (`takeDestination`).
 */
export const leave = (context: GateContext, href?: string): void => {
  if (provisional && href != null) writeLastKnown("destination", href);
  provisional = false;
  context.transport.revokeWrites();
};

/**
 * After a provisional render: wait for the host's answer, then re-run the
 * route gates (`invalidate`), which now decide from fresh state. A check cut
 * off by a dropped socket is tried again on the next one.
 */
export const confirmProvisional = async (
  context: GateContext,
  route: GateRoute,
  invalidate: () => Promise<void>
): Promise<void> => {
  for (;;) {
    try {
      await freshGate(context, route);
      break;
    } catch (error) {
      if (!(await untilOpen(context.transport))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await invalidate();
};

/** The remembered destination for this user, once. */
export const takeDestination = (): string | null => {
  const href = readLastKnown<string>("destination");
  if (href != null) writeLastKnown("destination", null);
  return href;
};

/**
 * `work`, awaited only while the transport is open (spec 09 D12): on a
 * browser page still reaching its host the route renders at once and its
 * components show the collections' loading or failed state.
 */
export const unlessConnecting = async (
  transport: { readonly state: string },
  work: Promise<unknown>
): Promise<void> => {
  if (transport.state === "open") await work;
  else void work.catch(() => undefined);
};

/** The routes whose `beforeLoad` is a gate (`keep()` or `leave()`). */
const GATED = new Set(["/_shell", "/_bare/onboarding"]);

/** What `followWriteAuthorization` needs of the router. */
export interface GateRouter {
  readonly state: { readonly matches: readonly { routeId: string }[] };
  invalidate(options: {
    filter: (match: { routeId: string }) => boolean;
  }): Promise<void>;
}

/** `run`, at most once at a time; asked again meanwhile, once more after. */
const coalesced = (run: () => Promise<void>): (() => void) => {
  let running = false;
  let again = false;
  const start = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        again = false;
        await run().catch((error: unknown) =>
          console.warn("[gate] re-check deferred", error)
        );
      } while (again);
      running = false;
    })();
  };
  return start;
};

/**
 * Browser only (spec 09 D12): write authorization follows the signed-in
 * answer. Whenever it is invalidated (a credentials notice, this window's
 * own credential change, the settings stream reopening) and on every
 * replacement socket (which the transport opens with writes suspended),
 * writes are suspended and the route gates re-run from fresh state: the one
 * that keeps its route releases them, one that leaves revokes them. Outside
 * a gated route the answer itself decides.
 */
export const followWriteAuthorization = (
  context: GateContext,
  router: GateRouter
): (() => void) => {
  const { queryClient, transport } = context;
  const query = signedInQuery(transport);
  const key = hashKey(query.queryKey);
  const recheck = coalesced(async () => {
    if (router.state.matches.some((match) => GATED.has(match.routeId))) {
      await router.invalidate({ filter: (match) => GATED.has(match.routeId) });
      return;
    }
    const ticket = transport.writeTicket();
    const signedIn = canSignOutOfAbacus(await queryClient.fetchQuery(query));
    if (signedIn) transport.confirmWrites(ticket);
    else transport.revokeWrites();
  });
  const reauthorize = (): void => {
    transport.suspendWrites();
    recheck();
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "invalidate" &&
      event.query.queryHash === key
    )
      reauthorize();
  });
  let seen = transport.generation;
  const unfollow = transport.onChange(() => {
    if (transport.state !== "open" || transport.generation === seen) return;
    const replaced = seen > 0;
    seen = transport.generation;
    if (!replaced) return;
    // The gate must ask the host again, not answer from the cache.
    void queryClient.invalidateQueries({
      queryKey: query.queryKey,
      exact: true,
      refetchType: "none",
    });
    reauthorize();
  });
  return () => {
    unsubscribe();
    unfollow();
  };
};
