import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { createHarness } from "#renderer/test-support/app-harness";

import {
  effectiveCheckoutIdentity,
  sessionsQueries,
  useCheckoutWatch,
} from "./queries";
it("every checkout query separates attach, detach and relocated roots with the same session id", async () => {
  const harness = await createHarness("/sessions/new");
  try {
    const checkout = { workspaceId: "w", sessionId: "s" };
    const primary = effectiveCheckoutIdentity("w", undefined, "/primary");
    const attached = effectiveCheckoutIdentity(
      "w",
      { worktreeId: "t", worktreePath: "/tree" },
      "/primary"
    );
    const relocated = effectiveCheckoutIdentity("w", undefined, "/moved");
    const keys = (identity: string) => {
      const q = sessionsQueries(harness.transport.orpc, identity);
      return [
        q.checkoutStatus(checkout),
        q.tree(checkout),
        q.children(checkout, "dir"),
        q.search(checkout, "file"),
        q.branches(checkout),
        q.branch(checkout),
        q.pr(checkout),
        q.diff(checkout, "file", "staged", "hash"),
      ].map((q) => q.queryKey);
    };
    keys(primary).forEach((key, i) => {
      expect(key).not.toEqual(keys(attached)[i]);
      expect(key).not.toEqual(keys(relocated)[i]);
      expect(key.at(-1)).toBe(primary);
    });
  } finally {
    await harness.cleanup();
  }
});
it("git watch aborts and reopens when effective checkout changes", async () => {
  const signals: AbortSignal[] = [];
  const watch = vi.fn(async function* (_, { signal }) {
    signals.push(signal);
    await new Promise<void>((done) =>
      signal.addEventListener("abort", done, { once: true })
    );
    yield* [];
  });
  const transport = {
    state: "open",
    generation: 1,
    client: { git: { watch } },
  } as never;
  const checkout = { workspaceId: "w", sessionId: "s" };
  const hook = renderHook(
    ({ identity }) => useCheckoutWatch(transport, checkout, identity),
    { initialProps: { identity: "w:primary:/primary" } }
  );
  await waitFor(() => expect(signals).toHaveLength(1));
  hook.rerender({ identity: "w:tree:/tree" });
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  hook.unmount();
  expect(signals[1]!.aborted).toBe(true);
});
