/**
 * The mounted app follows each keyless notice stream with one stream, and
 * every area that declares what a notice makes stale is mounted: a notice
 * reaches the queries of the settings, library, bots and sessions areas.
 */
import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { IS_ELECTRON } from "#renderer/lib/platform";
import { renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract) as never as Record<
  string,
  Record<string, { handler(fn: unknown): unknown }>
>;
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

/** A held-open stream per area, counting opens; `push` feeds every open one. */
const streams = (areas: string[]) => {
  const opens: Record<string, number> = {};
  const queues = new Map<string, Array<(event: unknown) => void>>();
  const procedures: Record<string, unknown> = {};
  for (const area of areas) {
    opens[area] = 0;
    queues.set(area, []);
    const procedure = area === "ai" ? "attention" : "events";
    procedures[area] = {
      [procedure]: (
        os[area]![procedure] as never as {
          handler(fn: unknown): unknown;
        }
      ).handler(async function* ({ signal }: { signal?: AbortSignal }) {
        opens[area]! += 1;
        const pending: unknown[] = [];
        let wake = () => undefined as void;
        queues.get(area)!.push((event) => {
          pending.push(event);
          wake();
        });
        if (area === "ai") yield { type: "snapshot", revision: 0, items: [] };
        if (area === "connectors") yield { type: "snapshot", requests: [] };
        signal?.addEventListener("abort", () => wake(), { once: true });
        while (!signal?.aborted) {
          if (pending.length > 0) yield pending.shift();
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      }),
    };
  }
  return {
    opens,
    procedures,
    push: (area: string, event: unknown) => {
      for (const send of queues.get(area)!) send(event);
    },
  };
};

it("opens each keyless stream once and reaches every area's queries", async () => {
  const keyless = [
    "ai",
    "bots",
    "connectors",
    "files",
    "memory",
    "messaging",
    "routines",
    "settings",
    "system",
    ...(IS_ELECTRON ? ["browser", "devices", "window"] : []),
  ];
  const fake = streams(keyless);
  app = await renderApp("/routines", { procedures: fake.procedures });
  await waitFor(() =>
    expect(Object.values(fake.opens).every((count) => count > 0)).toBe(true)
  );
  expect(fake.opens).toEqual(
    Object.fromEntries(keyless.map((area) => [area, 1]))
  );
  const { queryClient, transport } = app.router.options.context;
  const invalidated = vi.spyOn(queryClient, "invalidateQueries");
  const { orpc } = transport;
  const reached = (queryKey: readonly unknown[]) =>
    invalidated.mock.calls.some(
      ([filters]) =>
        JSON.stringify(filters?.queryKey) === JSON.stringify(queryKey)
    );
  await act(async () => {
    fake.push("messaging", { type: "updated" });
    fake.push("memory", { type: "changed" });
    fake.push("bots", { type: "previews-changed" });
    fake.push("settings", { type: "credentials-changed", provider: "x" });
  });
  await waitFor(() => {
    // The library (statuses on a messaging notice), the bots area and the
    // settings follower.
    expect(reached(orpc.connectors.statuses.queryKey({ input: {} }))).toBe(
      true
    );
    expect(reached(orpc.bots.chatPreviews.queryKey({ input: {} }))).toBe(true);
    expect(reached(orpc.memory.bots.queryKey({ input: {} }))).toBe(true);
    expect(reached(orpc.settings.get.key())).toBe(true);
  });
});
