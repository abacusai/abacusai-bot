/**
 * R1-T20: window.ready({ barrier: "subscriptions" }) exactly once per
 * document, for shell and bare entry routes alike, only after prefs,
 * sessions and workspaces are ready; "failed" when one of them errors.
 */
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultSeed,
  renderApp,
  type AppHarness,
} from "#renderer/test-support/app-harness";

import { ReadinessReporter } from "./readiness";

let harness: AppHarness | null = null;
afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

const readyCalls = (h: AppHarness) =>
  h.calls.filter(([name]) => name === "window.ready");

describe("ReadinessReporter", () => {
  it.each(["/bots/new", "/onboarding/welcome", "/__ui"])(
    "reports subscriptions once for a direct launch into %s",
    async (path) => {
      harness = await renderApp(path);
      await waitFor(() => expect(readyCalls(harness!)).toHaveLength(1));
      expect(readyCalls(harness)[0]![1]).toEqual({ barrier: "subscriptions" });
      for (const name of ["prefs", "sessions", "workspaces"] as const)
        expect(harness.collections[name].status).toBe("ready");
    }
  );

  it("waits for the sessions snapshot (Codex impl r1 #14)", async () => {
    let release: () => void = () => undefined;
    harness = await renderApp("/onboarding/welcome", {
      beforeRender: (db) => {
        release = db.sessions.holdSnapshot();
      },
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(harness.collections.sessions.status).not.toBe("ready");
    expect(readyCalls(harness)).toHaveLength(0);
    await act(async () => release());
    await waitFor(() => expect(readyCalls(harness!)).toHaveLength(1));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(readyCalls(harness)).toHaveLength(1);
  });

  it("a remount (HMR) in the same document never reports again", async () => {
    harness = await renderApp("/bots/new");
    await waitFor(() => expect(readyCalls(harness!)).toHaveLength(1));
    const again = render(
      <ReadinessReporter
        transport={harness.transport}
        collections={harness.collections}
      />
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(readyCalls(harness)).toHaveLength(1);
    again.unmount();
  });

  it("does not repeat on navigation", async () => {
    harness = await renderApp("/bots/new");
    await waitFor(() => expect(readyCalls(harness!)).toHaveLength(1));
    await act(async () => {
      await harness!.router.navigate({ to: "/sessions/new" } as never);
      await harness!.router.navigate({ to: "/settings/general" } as never);
    });
    expect(readyCalls(harness)).toHaveLength(1);
  });

  it("reports failed when one of the tables errors", async () => {
    const seed = defaultSeed();
    harness = await renderApp("/onboarding/welcome", {
      seed,
      beforeRender: (db) => {
        db.workspaces.failSnapshot = new Error("UNAVAILABLE");
      },
    });
    await waitFor(() => expect(readyCalls(harness!)).toHaveLength(1));
    expect(readyCalls(harness)[0]![1]).toMatchObject({ barrier: "failed" });
  });
});
