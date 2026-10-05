/**
 * Notice streams (spec 00 A.12): a stream a reopen cannot fix stops instead
 * of retrying forever; a transient failure reopens. The keyless hub: one
 * stream per transport, a late follower gets the folded snapshot, followers
 * are isolated; rules invalidate once.
 */
import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "#renderer/data/transport/memory";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { followNotice, followNotices, noticeSnapshot } from "./notices";
import { followSettingsNotices } from "./settings";
import { followWindowNotices } from "./window";

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

describe('followNotice("attention")', () => {
  it("shares one stream, replays the current snapshot to a late subscriber and closes after the last", async () => {
    const queue: unknown[] = [];
    let wake = () => undefined as void;
    let closed = false;
    const attention = vi.fn(
      async (_input: unknown, { signal }: { signal: AbortSignal }) =>
        (async function* () {
          signal.addEventListener("abort", () => wake(), { once: true });
          while (!signal.aborted) {
            if (queue.length > 0) yield queue.shift();
            else await new Promise<void>((resolve) => (wake = resolve));
          }
          closed = true;
        })()
    );
    const push = (event: unknown) => {
      queue.push(event);
      wake();
    };
    const transport = {
      state: "open",
      client: { ai: { attention } },
    } as never;
    const item = (threadId: string) => ({
      threadId,
      questions: 1,
      approvals: 0,
      firstTitle: null,
      oldestAt: 1,
    });
    const first: unknown[] = [];
    const second: unknown[] = [];
    const late: unknown[] = [];
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    followNotice(
      "attention",
      transport,
      (event) => first.push(event),
      a.signal
    );
    followNotice(
      "attention",
      transport,
      (event) => second.push(event),
      b.signal
    );
    push({ type: "snapshot", revision: 1, items: [item("t1")] });
    push({ type: "upsert", revision: 2, item: item("t2") });
    push({ type: "remove", revision: 3, threadId: "t1" });
    await vi.waitFor(() => expect(first).toHaveLength(3));
    expect(second).toEqual(first);
    expect(attention).toHaveBeenCalledTimes(1);
    followNotice("attention", transport, (event) => late.push(event), c.signal);
    expect(late).toEqual([
      { type: "snapshot", revision: 3, items: [item("t2")] },
    ]);
    a.abort();
    b.abort();
    expect(closed).toBe(false);
    c.abort();
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(attention).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing subscriber: the others get every event and the stream stays open", async () => {
    const { transport, push, attention } = fakeStream("attention");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy: unknown[] = [];
    const late: unknown[] = [];
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    followNotice(
      "attention",
      transport,
      () => {
        throw new Error("reducer bug");
      },
      a.signal
    );
    followNotice(
      "attention",
      transport,
      (event) => healthy.push(event),
      b.signal
    );
    push({ type: "snapshot", revision: 1, items: [] });
    push({ type: "upsert", revision: 2, item: item("t1") });
    await vi.waitFor(() => expect(healthy).toHaveLength(2));
    // A late joiner that throws on the snapshot does not break its mount.
    expect(() =>
      followNotice(
        "attention",
        transport,
        () => {
          throw new Error("snapshot bug");
        },
        c.signal
      )
    ).not.toThrow();
    push({ type: "remove", revision: 3, threadId: "t1" });
    await vi.waitFor(() => expect(healthy).toHaveLength(3));
    followNotice("attention", transport, (event) => late.push(event), c.signal);
    expect(late).toEqual([{ type: "snapshot", revision: 3, items: [] }]);
    expect(attention).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    a.abort();
    b.abort();
    c.abort();
    error.mockRestore();
  });

  it("drops a late subscriber that aborts while receiving its snapshot", async () => {
    const { transport, push, isClosed } = fakeStream("attention");
    const a = new AbortController();
    const b = new AbortController();
    const seen: unknown[] = [];
    followNotice("attention", transport, (event) => seen.push(event), a.signal);
    push({ type: "snapshot", revision: 1, items: [] });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const reentrant = vi.fn(() => b.abort());
    followNotice("attention", transport, reentrant, b.signal);
    expect(reentrant).toHaveBeenCalledTimes(1);
    a.abort();
    await vi.waitFor(() => expect(isClosed()).toBe(true));
  });

  it("treats the same callback registered twice as two subscriptions", async () => {
    const { transport, push, isClosed } = fakeStream("attention");
    const receive = vi.fn();
    const a = new AbortController();
    const b = new AbortController();
    followNotice("attention", transport, receive, a.signal);
    followNotice("attention", transport, receive, b.signal);
    push({ type: "snapshot", revision: 1, items: [] });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    a.abort();
    push({ type: "upsert", revision: 2, item: item("t1") });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(3));
    expect(isClosed()).toBe(false);
    b.abort();
    await vi.waitFor(() => expect(isClosed()).toBe(true));
  });
});

describe('followNotice("connectors")', () => {
  it("folds requests and clears into the snapshot a late subscriber receives, isolating a throwing one", async () => {
    const { transport, push, events } = fakeStream("connectors");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = (requestId: string) => ({ requestId }) as never;
    const healthy: unknown[] = [];
    const late: unknown[] = [];
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    followNotice(
      "connectors",
      transport,
      () => {
        throw new Error("boom");
      },
      a.signal
    );
    followNotice(
      "connectors",
      transport,
      (event) => healthy.push(event),
      b.signal
    );
    push({ type: "snapshot", requests: [request("r1")] });
    push({ type: "request", request: request("r2") });
    push({ type: "cleared", requestId: "r1" });
    await vi.waitFor(() => expect(healthy).toHaveLength(3));
    followNotice(
      "connectors",
      transport,
      (event) => late.push(event),
      c.signal
    );
    expect(late).toEqual([{ type: "snapshot", requests: [request("r2")] }]);
    expect(events).toHaveBeenCalledTimes(1);
    a.abort();
    b.abort();
    c.abort();
    error.mockRestore();
  });
});

const item = (threadId: string) => ({
  threadId,
  questions: 1,
  approvals: 0,
  firstTitle: null,
  oldestAt: 1,
});

/** A keyless stream the test feeds by hand; `isClosed` once it is aborted. */
const fakeStream = (kind: "attention" | "connectors") => {
  const queue: unknown[] = [];
  let wake = () => undefined as void;
  let closed = false;
  const stream = vi.fn(
    async (_input: unknown, { signal }: { signal: AbortSignal }) =>
      (async function* () {
        signal.addEventListener("abort", () => wake(), { once: true });
        while (!signal.aborted) {
          if (queue.length > 0) yield queue.shift();
          else await new Promise<void>((resolve) => (wake = resolve));
        }
        closed = true;
      })()
  );
  const transport = {
    state: "open",
    client:
      kind === "attention"
        ? { ai: { attention: stream } }
        : { connectors: { events: stream } },
  } as never;
  return {
    transport,
    attention: stream,
    events: stream,
    push: (event: unknown) => {
      queue.push(event);
      wake();
    },
    isClosed: () => closed,
  };
};

/** A transport whose keyless `area.events` the test feeds; `opens` counts. */
const fakeEvents = (area: "settings" | "window") => {
  const real = createMemoryTransport({} as never, {});
  let queue: unknown[] = [];
  let wake = () => undefined as void;
  let opens = 0;
  let fail: (() => void) | undefined;
  const events = vi.fn(
    async (_input: unknown, { signal }: { signal: AbortSignal }) => {
      opens += 1;
      return (async function* () {
        signal.addEventListener("abort", () => wake(), { once: true });
        let failed = false;
        fail = () => {
          failed = true;
          wake();
        };
        while (!signal.aborted) {
          if (failed) throw new Error("stream dropped");
          if (queue.length > 0) yield queue.shift();
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      })();
    }
  );
  const transport = {
    state: "open",
    orpc: real.orpc,
    client: { [area]: { events } },
  } as never;
  return {
    transport,
    real,
    opens: () => opens,
    drop: () => fail?.(),
    push: (event: unknown) => {
      queue = [...queue, event];
      wake();
    },
  };
};

const context = (transport: never) => {
  const invalidateQueries = vi.fn(async () => {});
  const setQueryData = vi.fn();
  return {
    invalidateQueries,
    setQueryData,
    context: {
      transport,
      queryClient: { invalidateQueries, setQueryData } as never,
      db: {} as never,
    },
  };
};

describe("the settings and window followers", () => {
  it("credentials invalidate the settings keys, exec-backend only the backend and sandbox, anything else nothing", async () => {
    const fake = fakeEvents("settings");
    const { context: ctx, invalidateQueries } = context(fake.transport);
    const abort = new AbortController();
    followSettingsNotices(ctx.transport, ctx.queryClient, abort.signal);
    const { orpc } = fake.real;
    fake.push({ type: "credentials-changed", provider: "openai" });
    await vi.waitFor(() =>
      expect(invalidateQueries.mock.calls).toEqual(
        [
          orpc.settings.keys.listProviders.key(),
          orpc.account.key(),
          orpc.models.list.key(),
          orpc.settings.get.key(),
          orpc.connectors.statuses.key(),
        ].map((queryKey) => [{ queryKey }])
      )
    );
    invalidateQueries.mockClear();
    fake.push({ type: "a-future-kind" });
    fake.push({ type: "exec-backend", backend: "docker" });
    await vi.waitFor(() => expect(invalidateQueries).toHaveBeenCalledTimes(2));
    expect(invalidateQueries.mock.calls).toEqual([
      [{ queryKey: orpc.settings.execBackend.get.key() }],
      [{ queryKey: orpc.settings.sandboxSupport.key() }],
    ]);
    abort.abort();
    fake.real.close();
  });

  it("a reopen invalidates what a lost notice could have, the first open nothing", async () => {
    const fake = fakeEvents("settings");
    const { context: ctx, invalidateQueries } = context(fake.transport);
    const abort = new AbortController();
    followSettingsNotices(ctx.transport, ctx.queryClient, abort.signal);
    await vi.waitFor(() => expect(fake.opens()).toBe(1));
    expect(invalidateQueries).not.toHaveBeenCalled();
    fake.drop();
    await vi.waitFor(() => expect(fake.opens()).toBe(2), { timeout: 3_000 });
    await vi.waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: fake.real.orpc.settings.execBackend.get.key(),
      })
    );
    abort.abort();
    fake.real.close();
  });

  it("never invalidates the chrome query: the notice carries the state", async () => {
    if (!IS_ELECTRON) return;
    const fake = fakeEvents("window");
    const {
      context: ctx,
      invalidateQueries,
      setQueryData,
    } = context(fake.transport);
    const abort = new AbortController();
    followWindowNotices(ctx.transport, ctx.queryClient, abort.signal);
    const chrome = {
      mode: "overlay",
      fullScreen: false,
      density: "comfortable",
      toolbarHeight: 40,
    };
    fake.push({ type: "chrome", chrome });
    await vi.waitFor(() => expect(setQueryData).toHaveBeenCalledTimes(1));
    expect(setQueryData.mock.calls[0]?.[1]).toEqual(chrome);
    expect(invalidateQueries).not.toHaveBeenCalled();
    abort.abort();
    fake.real.close();
  });
});

describe("noticeSnapshot", () => {
  it("keeps the last state and tells its subscribers when the stream stops for good", async () => {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const attention = vi.fn(async () =>
      (async function* () {
        yield { type: "snapshot", revision: 1, items: [item("t1")] };
        await stopped;
        throw new ORPCError("FORBIDDEN");
      })()
    );
    const transport = {
      state: "open",
      client: { ai: { attention } },
    } as never;
    const source = noticeSnapshot("attention", transport);
    const changed = vi.fn();
    const unsubscribe = source.subscribe(changed);
    await vi.waitFor(() => expect(source.get()?.items).toHaveLength(1));
    const before = changed.mock.calls.length;
    stop();
    await vi.waitFor(() =>
      expect(changed.mock.calls.length).toBeGreaterThan(before)
    );
    expect(source.get()?.items).toEqual([item("t1")]);
    expect(attention).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("follows the stream itself: no other follower is needed", async () => {
    const { transport, push, isClosed } = fakeStream("connectors");
    const source = noticeSnapshot("connectors", transport);
    const unsubscribe = source.subscribe(() => undefined);
    push({ type: "snapshot", requests: [] });
    await vi.waitFor(() =>
      expect(source.get()).toEqual({ type: "snapshot", requests: [] })
    );
    unsubscribe();
    await vi.waitFor(() => expect(isClosed()).toBe(true));
  });
});
