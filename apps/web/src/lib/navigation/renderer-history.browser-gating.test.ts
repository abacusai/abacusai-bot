import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { createAppRouter } from "#renderer/router";
import { createHarness } from "#renderer/test-support/app-harness";

import { openTargetOptions } from "./open-target-options";
import { rendererHistory } from "./renderer-history";

const originalHref = window.location.href;
afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", originalHref);
});

it("loads direct paths and builds typed URLs and route masks under the Vite basepath", async () => {
  vi.stubEnv("BASE_URL", "/bot/");
  window.history.replaceState(null, "", "/bot/settings/general");
  const harness = await createHarness("/settings/general");
  const router = createAppRouter({ context: harness.router.options.context });
  try {
    await router.load();
    expect(router.state.location.pathname).toBe("/settings/general");
    expect(router.state.location.publicHref).toBe("/bot/settings/general");
    expect(router.state.matches.at(-1)?.routeId).toBe(
      "/_shell/settings/general"
    );
    expect(
      router.buildLocation({
        to: "/sessions/$sessionId",
        params: { sessionId: "a/b" },
        search: { tab: "files" },
      }).href
    ).toBe("/bot/sessions/a%2Fb?tab=files");
    await router.navigate({ to: "/settings/models" });
    router.history.flush();
    expect(location.pathname).toBe("/bot/settings/models");
    expect(location.hash).toBe("");
    // RouterProvider normally subscribes to history and loads the new route.
    router.history.back();
    await waitFor(() =>
      expect(router.history.location.pathname).toBe("/bot/settings/general")
    );
    await router.load();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/general")
    );
    expect(location.pathname).toBe("/bot/settings/general");
    router.history.forward();
    await waitFor(() =>
      expect(router.history.location.pathname).toBe("/bot/settings/models")
    );
    await router.load();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/models")
    );
    expect(location.pathname).toBe("/bot/settings/models");
    expect(
      router.buildLocation(
        openTargetOptions({
          kind: "routine-run",
          routineId: "a/b",
          sessionId: "s&x",
        })
      ).publicHref
    ).toBe("/bot/routines/a%2Fb?run=s%26x");
    const masked = router.buildLocation({
      to: "/routines/$routineId/edit",
      params: { routineId: "r" },
    });
    expect(masked.maskedLocation?.href).toBe("/bot/routines/r");
    // Recreating the router models a refresh at a nested URL.
    const reloaded = createAppRouter({
      context: harness.router.options.context,
    });
    try {
      await reloaded.load();
      expect(reloaded.state.matches.at(-1)?.routeId).toBe(
        "/_shell/settings/models"
      );
    } finally {
      reloaded.history.destroy();
    }
  } finally {
    router.history.destroy();
    await harness.cleanup();
  }
});

it.each([
  ["/", "/settings/general"],
  ["/workspace/", "/workspace/settings/general"],
])("uses the configured mount path %s", (base, href) => {
  vi.stubEnv("BASE_URL", base);
  window.history.replaceState(null, "", href);
  const { history, basepath } = rendererHistory();
  try {
    expect(basepath).toBe(base);
    expect(history.location.href).toBe(href);
  } finally {
    history.destroy();
  }
});
