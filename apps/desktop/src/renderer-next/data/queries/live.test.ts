/**
 * Notice streams (spec 00 A.12): a stream a reopen cannot fix stops instead
 * of retrying forever; a `chrome` notice updates the query without a refetch.
 */
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "#next/data/transport/memory";

import { keysFor } from "./invalidation";
import { followNotices } from "./live";

describe("followNotices", () => {
  it("stops on FORBIDDEN instead of reopening every second (Claude impl r1 #22)", async () => {
    const open = vi.fn(async () => {
      throw new ORPCError("FORBIDDEN");
    });
    const abort = new AbortController();
    const done = followNotices(
      { state: "open" },
      open,
      () => undefined,
      abort.signal
    );
    await expect(
      Promise.race([
        done.then(() => "stopped"),
        new Promise((resolve) =>
          setTimeout(() => resolve("still running"), 1_500)
        ),
      ])
    ).resolves.toBe("stopped");
    expect(open).toHaveBeenCalledTimes(1);
    abort.abort();
  });

  it("still reopens after a transient failure", async () => {
    let calls = 0;
    const events: number[] = [];
    const abort = new AbortController();
    const open = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hiccup");
      return (async function* () {
        yield 1;
        abort.abort();
      })();
    });
    await followNotices(
      { state: "open" },
      open,
      (event) => events.push(event),
      abort.signal
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(events).toEqual([1]);
  });
});

describe("keysFor", () => {
  it("never invalidates the chrome query: the notice carries the state", () => {
    const transport = createMemoryTransport({} as never, {});
    expect(
      keysFor(transport.orpc, {
        source: "window",
        event: {
          type: "chrome",
          chrome: {
            mode: "overlay",
            fullScreen: false,
            density: "comfortable",
            toolbarHeight: 40,
          },
        } as never,
      })
    ).toEqual([]);
    expect(
      keysFor(transport.orpc, {
        source: "settings",
        event: { type: "credentials-changed" } as never,
      })
    ).toHaveLength(3);
    transport.close();
  });
});

it("exec-backend events invalidate the query shared by the context tray and picker", () => {
  const transport = createMemoryTransport({} as never, {});
  try {
    expect(
      keysFor(transport.orpc, {
        source: "settings",
        event: {
          type: "exec-backend",
          backend: { selected: "docker", effective: "docker", statuses: [] },
        } as never,
      })
    ).toEqual([
      transport.orpc.settings.execBackend.get.queryOptions({ input: {} })
        .queryKey,
    ]);
  } finally {
    transport.close();
  }
});
