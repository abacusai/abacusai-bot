/**
 * Hosted results for the app's notifications: read only while someone
 * listens, each finished run announced once, nothing from before listening,
 * a full page read on, and a long absence told as one summary.
 */
import type { HostedRoutineRun } from "@abacus-ai/contract/routines";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostedRoutineFeed, type HostedFeedEvent } from "./hosted-feed";

const run = (id: string, at: number): HostedRoutineRun => ({
  id,
  routineId: "hosted-r1",
  name: "Digest",
  status: "done",
  at,
  deliveredVia: "email",
  delivered: true,
  summary: "Three meetings",
});

const hosted = (options: { pages?: HostedRoutineRun[][] }) => {
  const pages = [...(options.pages ?? [])];
  let clock = 0;
  return {
    feed: vi.fn(async (_since: string) => ({
      runs: pages.shift() ?? [],
      now: `server-now-${++clock}`,
    })),
    refresh: vi.fn(async () => []),
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the hosted results feed", () => {
  it("announces each new run once, from when listening began, on the server's clock", async () => {
    const server = hosted({
      pages: [
        [run("a", 1_100), run("b", 1_200)],
        [run("b", 1_200), run("c", 1_300)],
      ],
    });
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => 1_000,
    });
    const heard: string[] = [];
    const stop = feed.listen((event) => {
      if (event.type === "run") heard.push(event.run.id);
    });
    // The first read goes at once.
    await vi.waitFor(() => expect(server.refresh).toHaveBeenCalledTimes(1));
    expect(server.feed).toHaveBeenLastCalledWith(new Date(1_000).toISOString());
    // Each next read starts from the server's own clock.
    await feed.poll();
    expect(server.feed).toHaveBeenLastCalledWith("server-now-1");
    expect(heard).toEqual(["a", "b", "c"]);
    // The panel's rows are re-read when results arrive.
    expect(server.refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("an old server's refusal is no runs and keeps the last since", async () => {
    const server = hosted({});
    server.feed.mockResolvedValue({ runs: [], now: null as never });
    const written: string[] = [];
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => 0,
      store: { read: () => null, write: (since) => void written.push(since) },
    });
    const listener = vi.fn();
    feed.listen(listener);
    expect(await feed.poll()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("reads on its interval only while someone listens", async () => {
    vi.useFakeTimers();
    const server = hosted({});
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 120_000,
    });
    const stop = feed.listen(() => {});
    await vi.advanceTimersByTimeAsync(240_000);
    // The first read at once, then one each interval.
    expect(server.feed).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(server.feed).toHaveBeenCalledTimes(3);
  });

  it("keeps announcing to the others when one listener throws", async () => {
    const server = hosted({ pages: [[run("a", 5)]] });
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => 0,
      log: () => {},
    });
    const heard = vi.fn();
    feed.listen(() => {
      throw new Error("boom");
    });
    feed.listen(heard);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it("starts where the last read left off, across a restart", async () => {
    const server = hosted({ pages: [[run("a", 5)]] });
    const written: string[] = [];
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => 0,
      store: {
        read: () => "2026-10-08T01:00:00Z",
        write: (since) => {
          written.push(since);
        },
      },
    });
    const stop = feed.listen(() => {});
    await vi.waitFor(() => expect(written).toEqual(["server-now-1"]));
    expect(server.feed).toHaveBeenCalledWith("2026-10-08T01:00:00Z");
    stop();
  });

  it("reads on while a page comes back full, from that page's last finish", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      run(`p${i}`, Date.UTC(2026, 9, 8, 1, 0, i))
    );
    const server = hosted({ pages: [full, [run("tail", 9e12)]] });
    const written: string[] = [];
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => Date.UTC(2026, 9, 8, 2),
      store: {
        read: () => "2026-10-08T01:00:00.000Z",
        write: (since) => {
          written.push(since);
        },
      },
    });
    const heard: HostedFeedEvent[] = [];
    feed.listen((event) => heard.push(event));
    await vi.waitFor(() => expect(heard).toHaveLength(101));
    expect(server.feed.mock.calls.map(([since]) => since)).toEqual([
      "2026-10-08T01:00:00.000Z",
      new Date(Date.UTC(2026, 9, 8, 1, 0, 99)).toISOString(),
    ]);
    // The last page was short: the next read starts from the server's clock.
    expect(written.at(-1)).toBe("server-now-2");
  });

  it("stops paging when a full page brings nothing new", async () => {
    const full = Array.from({ length: 100 }, (_, i) => run(`p${i}`, 7_000));
    const server = hosted({ pages: [full, full, full] });
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => 0,
    });
    const heard = vi.fn();
    feed.listen(heard);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(100));
    await vi.waitFor(() => expect(server.feed).toHaveBeenCalledTimes(2));
  });

  it("tells a day's absence as one summary, then each run again", async () => {
    const server = hosted({
      pages: [[run("a", 1), run("b", 2)], [run("c", 3)]],
    });
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => Date.UTC(2026, 9, 8, 12),
      store: { read: () => "2026-10-06T12:00:00.000Z", write: () => {} },
    });
    const heard: HostedFeedEvent[] = [];
    feed.listen((event) => heard.push(event));
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    expect(heard[0]).toMatchObject({
      type: "away",
      runs: [{ id: "a" }, { id: "b" }],
    });
    await feed.poll();
    expect(heard[1]).toMatchObject({ type: "run", run: { id: "c" } });
  });

  it("announces each run after an absence under a day", async () => {
    const server = hosted({ pages: [[run("a", 1), run("b", 2)]] });
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => Date.UTC(2026, 9, 8, 12),
      store: { read: () => "2026-10-08T01:00:00.000Z", write: () => {} },
    });
    const heard: HostedFeedEvent[] = [];
    feed.listen((event) => heard.push(event));
    await vi.waitFor(() => expect(heard).toHaveLength(2));
    expect(heard.map((event) => event.type)).toEqual(["run", "run"]);
  });

  it("a failed read is logged, not thrown, and the next one goes on", async () => {
    const server = hosted({ pages: [[run("a", 1)]] });
    server.feed.mockRejectedValueOnce(new Error("offline"));
    const log = vi.fn();
    const feed = new HostedRoutineFeed({
      hosted: server,
      intervalMs: () => 60_000,
      now: () => 0,
      log,
    });
    const heard = vi.fn();
    feed.listen(heard);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(await feed.poll()).toMatchObject([{ id: "a" }]);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
