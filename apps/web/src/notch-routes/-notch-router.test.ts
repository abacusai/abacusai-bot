import { expect, it } from "vitest";

import type { NotchRouterContext } from "../notch-context";
import { createNotchRouter } from "../notch-router";

it("R6-T1 companion router has seven memory routes and replacement navigation", async () => {
  const router = createNotchRouter({} as NotchRouterContext);
  await router.load();
  const paths = Object.values(router.routesById).map((route) => route.fullPath);
  for (const path of [
    "/idle",
    "/working",
    "/approval/$id",
    "/reply/$id",
    "/call",
    "/done",
    "/failed",
  ])
    expect(paths).toContain(path);
  for (let index = 0; index < 50; index += 1)
    await router.navigate({
      href: index % 2 ? "/working" : "/idle",
      replace: true,
    });
  expect(router.history.length).toBe(1);
  expect(router.options.defaultPreload).toBe(false);
  expect(router.options.defaultViewTransition).toBe(false);
});
