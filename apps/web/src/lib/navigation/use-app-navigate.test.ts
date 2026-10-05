/**
 * The transition intent rides on the entry's state (spec 01 §6.7), and the
 * options are checked against the route tree (the `@ts-expect-error` lines
 * fail `tsc -b` if a wrong route or search param stops being an error).
 */
import { expect, it } from "vitest";

import { withIntent, type useAppNavigate } from "./use-app-navigate";

const previous = { __TSR_index: 3, key: "k" };

it("adds the intent over the previous state, or over the state given", () => {
  const kept = withIntent("nav-forward")(previous);
  expect(kept).toMatchObject({ __TSR_index: 3, key: "k" });
  expect(kept.navIntent?.type).toBe("nav-forward");
  const given = withIntent("none", (p) => ({ ...p, from: "menu" }))(previous);
  expect(given).toMatchObject({ __TSR_index: 3, from: "menu" });
  expect(given.navIntent?.type).toBe("none");
  expect(withIntent("none", { only: true } as never)(previous)).toEqual({
    only: true,
    navIntent: expect.objectContaining({ type: "none" }),
  });
});

it("checks the options against the route tree (at typecheck)", () => {
  // Never called: `tsc -b` checks it.
  const typed = (navigate: ReturnType<typeof useAppNavigate>) => {
    void navigate({
      to: "/settings/models",
      search: (old) => ({ ...old, provider: "openrouter" }),
      transition: "none",
    });
    // @ts-expect-error not a route
    void navigate({ to: "/settings/nowhere" });
    // @ts-expect-error `provider` is a string
    void navigate({ to: "/settings/models", search: { provider: 5 } });
    // @ts-expect-error not a transition
    void navigate({ to: "/settings/models", transition: "sideways" });
  };
  expect(typed).toBeTypeOf("function");
});
