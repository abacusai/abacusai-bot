/**
 * Navigation with an explicit view-transition intent (spec 01 §6.7). The
 * intent is written into the new history entry's state, so it belongs to
 * exactly that navigation; the router seam reads it when the entry commits.
 */
import {
  useNavigate,
  type HistoryState,
  type NavigateOptions,
  type RegisteredRouter,
} from "@tanstack/react-router";

import type { NavType } from "#renderer/lib/motion";

/**
 * `useNavigate`'s typed options plus the entry's transition intent. Without
 * a `to`, the target is the current route (`"."`), as the old untyped
 * options defaulted to.
 */
type AppNavigate<TDefaultFrom extends string> = <
  TRouter extends RegisteredRouter = RegisteredRouter,
  TTo extends string | undefined = ".",
  TFrom extends string = TDefaultFrom,
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = "",
>(
  options: NavigateOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & {
    transition?: NavType | "none";
  }
) => Promise<void>;

type StateOption = NavigateOptions["state"];
/** The current entry's parsed state, as the router passes it to `state`. */
type ParsedState = Parameters<
  Extract<NonNullable<StateOption>, (previous: never) => unknown>
>[0];

/** `state` for an entry that carries `transition` (and any given state). */
export const withIntent = (
  transition: NavType | "none",
  given?: StateOption
): ((previous: ParsedState) => HistoryState) => {
  const intent = { id: crypto.randomUUID(), type: transition };
  return (previous) => ({
    ...(typeof given === "function"
      ? given(previous)
      : given === undefined || given === true
        ? previous
        : given),
    navIntent: intent,
  });
};

/**
 * `useNavigate` with a `transition` option. `from` defaults like
 * `useNavigate({ from })`; the options are checked against the route tree.
 */
export const useAppNavigate = <
  TDefaultFrom extends string = string,
>(defaults?: {
  from?: TDefaultFrom;
}): AppNavigate<TDefaultFrom> => {
  const navigate = useNavigate(defaults as never);
  return ({ transition, ...options }) =>
    navigate(
      // Checked at the call site; the generic options do not re-infer here.
      (transition === undefined
        ? options
        : { ...options, state: withIntent(transition, options.state) }) as never
    );
};
