/**
 * The router seam that adds React view-transition types (spec 01 §6.7, F7).
 *
 * The router commits matches inside its own `React.startTransition`, which
 * `Transitioner` assigns to `router.startTransition` on every render. It is
 * called twice for a slow navigation: once to offer pending matches (one match
 * `status: "pending"`) and once to commit. A superseded navigation returns
 * before its commit. So the seam wraps the assigned function and adds types
 * only on a commit call, only once per history entry key, for the location
 * that is actually committing; the types go in *inside* React's transition.
 *
 * Intent travels in the history entry's state (`navIntent`), so a cancelled,
 * blocked or superseded navigation never commits it.
 */
import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";
import { addTransitionType } from "react";

import type { NavType } from "#next/lib/motion";

import {
  inferNavType,
  type HistoryDirection,
  type PaneLocation,
} from "./nav-type";
import { paneKey } from "./pane-key";

type StartTransitionFn = AnyRouter["startTransition"];

/** Indirection so tests can observe what the seam adds. */
export const transitionTypeSink = {
  add: (type: NavType): void => addTransitionType(type),
  /** Each router transition the seam saw: a pending offer or a commit. */
  observe: (_kind: "offer" | "commit"): void => undefined,
};

const INSTALLED = Symbol.for("abacus.transitionTypes");

type NavState = {
  __TSR_key?: string;
  __TSR_index?: number;
  navIntent?: { id: string; type: NavType | "none" };
};

export const paneLocationOf = (
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
export const navTypesFor = (
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

export const installTransitionTypes = (router: AnyRouter): void => {
  const target = router as AnyRouter & { [INSTALLED]?: true };
  if (target[INSTALLED]) return;
  target[INSTALLED] = true;

  let inner: StartTransitionFn = router.startTransition;
  let lastCommittedKey: string | undefined;
  const seenKeys = new Set<string>();

  const wrapped: StartTransitionFn = (fn, expected) => {
    // offerPending passes one "pending" match; a commit has none.
    const isCommit = expected.every((match) => match.status !== "pending");
    transitionTypeSink.observe(isCommit ? "commit" : "offer");
    const next = router.latestLocation;
    const key = (next.state as NavState).__TSR_key;
    let types: NavType[] = [];
    if (isCommit && key !== lastCommittedKey) {
      types = navTypesFor(
        router,
        router.stores.resolvedLocation.get(),
        next,
        seenKeys
      );
    }
    if (isCommit) {
      lastCommittedKey = key;
      if (key !== undefined) seenKeys.add(key);
    }
    return inner(() => {
      for (const type of types) transitionTypeSink.add(type);
      fn();
    }, expected);
  };

  Object.defineProperty(router, "startTransition", {
    configurable: true,
    get: () => wrapped,
    // Transitioner reassigns on every render.
    set: (next: StartTransitionFn) => {
      inner = next;
    },
  });
};
