/**
 * Route-level view transitions (spec 01 §6.7 as amended, PLAN "Amendments").
 *
 * The router commits matches through store subscriptions, which React
 * renders synchronously (`useSyncExternalStore`) even inside
 * `startTransition`, so React never starts a view transition for a route
 * change: `addTransitionType` in the commit would be inert. Route-level
 * transitions are therefore the router's own document-level
 * `document.startViewTransition`, which this module configures through
 * `defaultViewTransition.types`:
 *
 * - The types are computed for the location that is **committing**: the
 *   router's current transaction location (`stores.location`, set with the
 *   transaction that owns the commit), never `latestLocation`, which a newer
 *   navigation may already have moved (Claude impl r1 #2).
 * - A commit with no type (a masked pop-up opening or closing, a
 *   search-only change, an `invalidate()` of the same entry, a pending
 *   screen) returns `false`: the router then starts **no** transition.
 * - Each history entry animates at most once: a second commit of the same
 *   entry key (a reload, an invalidate) is untyped.
 *
 * React `<ViewTransition>` is used only for in-route state changes React
 * commits itself; cross-route shared elements (bot identity) take a CSS
 * `view-transition-name` from `useSharedElementName` so they join this
 * document transition. Never two transitions in one commit
 * (`guardSingleViewTransition`, R1-T11b).
 *
 * Intent travels in the history entry's state (`navIntent`), so a
 * cancelled, blocked or superseded navigation never commits it.
 */
import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";

import type { NavType } from "#next/lib/motion";

import {
  inferNavType,
  type HistoryDirection,
  type PaneLocation,
} from "./nav-type";
import { paneKey } from "./pane-key";

/** Indirection so tests and the dev hooks can observe the chosen types. */
export const transitionTypeSink = {
  /** Each type a document-level view transition starts with. */
  document: (_type: NavType): void => undefined,
};

const INSTALLED = Symbol.for("abacus.transitionTypes");

type NavState = {
  __TSR_key?: string;
  __TSR_index?: number;
  navIntent?: { id: string; type: NavType | "none" };
};

const paneLocationOf = (
  router: AnyRouter,
  location: Pick<ParsedLocation, "pathname">
): PaneLocation | null => {
  const [matched, params, found] = router.getMatchedRoutes(location.pathname);
  const leaf = found ?? matched.at(-1);
  if (leaf == null) return null;
  return {
    fullPath: leaf.fullPath,
    paneKey: paneKey(leaf.id, params),
  };
};

/**
 * The types for committing `next` after `from`, with `seenKeys` the history
 * entries committed before (a forward traversal lands on one of those).
 */
const navTypesFor = (
  router: AnyRouter,
  from: ParsedLocation | undefined,
  next: ParsedLocation,
  seenKeys: ReadonlySet<string>
): NavType[] => {
  if (from == null) return [];
  const fromPane = paneLocationOf(router, from);
  const toPane = paneLocationOf(router, next);
  if (toPane == null) return [];
  const fromState = from.state as NavState;
  const nextState = next.state as NavState;
  const fromIndex = fromState.__TSR_index ?? 0;
  const nextIndex = nextState.__TSR_index ?? 0;
  const key = nextState.__TSR_key;
  const direction: HistoryDirection =
    nextIndex < fromIndex
      ? "back"
      : key !== undefined && seenKeys.has(key) && nextIndex > fromIndex
        ? "forward-seen"
        : "new";
  const type = inferNavType(
    fromPane,
    toPane,
    direction,
    direction === "new" ? nextState.navIntent?.type : undefined
  );
  return type == null ? [] : [type];
};

/** The location the router's current transaction commits. */
const committingLocation = (router: AnyRouter): ParsedLocation =>
  router.stores.location.get();

export const installTransitionTypes = (router: AnyRouter): void => {
  const target = router as AnyRouter & { [INSTALLED]?: true };
  if (target[INSTALLED]) return;
  target[INSTALLED] = true;

  const committedKeys = new Set<string>();
  let lastKey: string | undefined;
  (
    router.options as { defaultViewTransition?: unknown }
  ).defaultViewTransition = {
    // `toLocation` here is the router's `latestLocation`; ignored on purpose.
    types: ({ fromLocation }: { fromLocation?: ParsedLocation }) => {
      const next = committingLocation(router);
      const key = (next.state as NavState).__TSR_key;
      if (key !== undefined && key === lastKey) return false;
      const types = navTypesFor(router, fromLocation, next, committedKeys);
      lastKey = key;
      if (key !== undefined) committedKeys.add(key);
      for (const type of types) transitionTypeSink.document(type);
      return types.length > 0 ? types : false;
    },
  };
};
