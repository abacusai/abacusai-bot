/**
 * Navigation with an explicit view-transition intent (spec 01 §6.7). The
 * intent is written into the new history entry's state, so it belongs to
 * exactly that navigation; the router seam reads it when the entry commits.
 */
import {
  useRouter,
  type NavigateOptions,
  type RegisteredRouter,
} from "@tanstack/react-router";

import type { NavType } from "#next/lib/motion";

export type AppNavigateOptions = NavigateOptions<RegisteredRouter> & {
  transition?: NavType | "none";
};

const withIntent = <T extends { state?: unknown }>(
  options: T,
  transition: NavType | "none" | undefined
): T => {
  if (transition === undefined) return options;
  const intent = { id: crypto.randomUUID(), type: transition };
  const given = options.state;
  return {
    ...options,
    state: (previous: Record<string, unknown>) => ({
      ...(typeof given === "function"
        ? (given as (p: Record<string, unknown>) => Record<string, unknown>)(
            previous
          )
        : ((given as Record<string, unknown> | undefined) ?? previous)),
      navIntent: intent,
    }),
  };
};

export const useAppNavigate = (): ((
  options: AppNavigateOptions
) => Promise<void>) => {
  const router = useRouter();
  return ({ transition, ...options }) =>
    router.navigate(
      withIntent(options as NavigateOptions<RegisteredRouter>, transition)
    );
};

export { withIntent };
