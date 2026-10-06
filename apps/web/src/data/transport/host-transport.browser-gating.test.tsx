/**
 * The browser's host transport (spec 09 D2, D3): one transport per page, a
 * generation per socket, calls that wait for a socket without ever being
 * dispatched after they gave up, writes (by procedure, not by signal) held
 * until the sign-in gate confirms and revoked when it leaves, one deadline
 * per write, generations that end on a close or a liveness drop, and notice
 * loops that reopen on the next generation.
 */
import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { followNotices } from "#renderer/data/queries/notices";
import { createQueryClient, optimistic } from "#renderer/data/query-client";
import { initI18n } from "#renderer/lib/i18n";

import { isHostUnavailable } from "./lifecycle";
import { createHostTransport, type HostTransport } from "./websocket";

/** An open socket that records what the link writes to it. */
class FakeSocket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  send = vi.fn((data: string) => {
    this.sent.push(data);
  });
  close = vi.fn(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
}

/** Like a browser: `close()` is CLOSING at once, the event comes later. */
class SlowCloseSocket extends FakeSocket {
  override close = vi.fn((code?: number) => {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => {
      this.readyState = 3;
      this.dispatchEvent(
        Object.assign(new Event("close"), { code: code ?? 1000, reason: "" })
      );
    }, 1000);
  });
}

const socket = () => new FakeSocket();
/** A user's write (a mutation): held until confirmed, with a deadline. */
const write = (transport: HostTransport) =>
  transport.client.system.funnelStep({ step: "first_bot_shown" } as never);
const asSocket = (fake: FakeSocket) => fake as unknown as WebSocket;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const transports: HostTransport[] = [];
const create = (options?: Parameters<typeof createHostTransport>[0]) => {
  const transport = createHostTransport({ flowControl: false, ...options });
  transports.push(transport);
  return transport;
};
afterEach(() => {
  vi.useRealTimers();
  for (const transport of transports.splice(0)) transport.close();
});

describe("createHostTransport", () => {
  it("is connecting, then open per generation, then reconnecting between sockets", () => {
    const transport = create();
    const states: string[] = [];
    transport.onChange(() =>
      states.push(`${transport.state}:${transport.generation}`)
    );
    expect([transport.state, transport.generation]).toEqual(["connecting", 0]);
    const first = socket();
    transport.attach(asSocket(first));
    first.close();
    transport.attach(asSocket(socket()));
    expect(states).toEqual(["open:1", "reconnecting:1", "open:2"]);
  });

  it("queues a read made while connecting and sends it on the first socket", async () => {
    const transport = create();
    const abort = new AbortController();
    void transport.client.system
      .info({}, { signal: abort.signal })
      .catch(() => undefined);
    await flush();
    const first = socket();
    transport.attach(asSocket(first));
    await vi.waitFor(() => expect(first.sent.length).toBe(1));
    expect(first.sent[0]).toContain("system");
    abort.abort();
  });

  it("never dispatches a write that timed out, even when a socket opens later", async () => {
    vi.useFakeTimers();
    const transport = create({ writesConfirmed: true, deadlineMs: 1000 });
    const outcome = write(transport).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(isHostUnavailable(await outcome)).toBe(true);
    const late = socket();
    transport.attach(asSocket(late));
    await vi.advanceTimersByTimeAsync(50);
    expect(late.sent).toEqual([]);
  });

  it("never dispatches an aborted call", async () => {
    const transport = create({ writesConfirmed: true });
    const abort = new AbortController();
    const call = transport.client.system
      .info({}, { signal: abort.signal })
      .catch((error: unknown) => error);
    abort.abort();
    expect(await call).toBeDefined();
    const late = socket();
    transport.attach(asSocket(late));
    await flush();
    expect(late.sent).toEqual([]);
  });

  it("aborts before dispatch when the signal fires after the socket opened", async () => {
    const transport = create({ writesConfirmed: true });
    const abort = new AbortController();
    const call = transport.client.system
      .info({}, { signal: abort.signal })
      .catch((error: unknown) => error);
    const late = socket();
    // The resolver resolves on attach; the abort lands before the dispatch.
    transport.attach(asSocket(late));
    abort.abort();
    await call;
    await flush();
    expect(late.sent).toEqual([]);
  });

  it("holds writes until confirmed and revokes them unsent when the gate leaves", async () => {
    const transport = create();
    const open = socket();
    transport.attach(asSocket(open));
    const held = write(transport).catch((error: unknown) => error);
    const read = new AbortController();
    void transport.client.system
      .info({}, { signal: read.signal })
      .catch(() => undefined);
    await vi.waitFor(() => expect(open.sent.length).toBe(1));
    expect(open.sent[0]).toContain("info");
    transport.revokeWrites();
    expect(isHostUnavailable(await held)).toBe(true);
    expect(open.sent.length).toBe(1);
    transport.confirmWrites();
    void write(transport).catch(() => undefined);
    await vi.waitFor(() => expect(open.sent.length).toBe(2));
    expect(open.sent[1]).toContain("funnelStep");
    read.abort();
  });

  it("releases held writes on confirmation", async () => {
    const transport = create();
    const open = socket();
    transport.attach(asSocket(open));
    void write(transport).catch(() => undefined);
    await flush();
    expect(open.sent).toEqual([]);
    transport.confirmWrites();
    await vi.waitFor(() => expect(open.sent.length).toBe(1));
  });

  it("holds a useMutation write (oRPC mutationOptions) like any other write", async () => {
    const transport = create();
    const open = socket();
    transport.attach(asSocket(open));
    const queryClient = createQueryClient();
    const observer = new MutationObserver(
      queryClient,
      transport.orpc.settings.toolsets.setEnabled.mutationOptions()
    );
    void observer
      .mutate({ toolsetId: "browser", enabled: false })
      .catch(() => undefined);
    await flush();
    expect(observer.getCurrentResult().isPending).toBe(true);
    expect(open.sent).toEqual([]);
    transport.confirmWrites();
    await vi.waitFor(() => expect(open.sent.length).toBe(1));
    expect(open.sent[0]).toContain("setEnabled");
    queryClient.clear();
  });

  it("held optimistic writes revoked together each roll back, refetch once, and toast one not sent", async () => {
    await initI18n();
    const transport = create();
    transport.attach(asSocket(socket()));
    const showError = vi.fn();
    const queryClient = createQueryClient({ showError });
    const reads = { toolsets: vi.fn(), notifications: vi.fn() };
    const keys = {
      toolsets: transport.orpc.settings.toolsets.get.queryKey({ input: {} }),
      notifications: transport.orpc.settings.notifications.get.queryKey({
        input: {},
      }),
    };
    const watched = [
      new QueryObserver(queryClient, {
        queryKey: keys.toolsets,
        queryFn: async () => (reads.toolsets(), { browser: true }),
        initialData: { browser: true },
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: keys.notifications,
        queryFn: async () => (
          reads.notifications(),
          { enabled: false, sound: false }
        ),
        initialData: { enabled: false, sound: false },
        staleTime: Infinity,
      }),
    ].map((observer) => observer.subscribe(() => {}));
    const meta = { errorToast: "phase5.failed" };
    const toolset = new MutationObserver(
      queryClient,
      transport.orpc.settings.toolsets.setEnabled.mutationOptions({
        ...optimistic(keys.toolsets, (data, change: { enabled: boolean }) => ({
          ...data,
          browser: change.enabled,
        })),
        meta,
      })
    );
    const notify = new MutationObserver(
      queryClient,
      transport.orpc.settings.notifications.set.mutationOptions({
        ...optimistic(
          keys.notifications,
          (_data, value: { enabled: boolean; sound: boolean }) => value
        ),
        meta,
      })
    );
    const writes = [
      toolset.mutate({ toolsetId: "browser", enabled: false }),
      notify.mutate({ enabled: true, sound: false }),
    ].map((write) => write.catch(() => "failed"));
    await vi.waitFor(() =>
      expect(queryClient.getQueryData(keys.notifications)).toEqual({
        enabled: true,
        sound: false,
      })
    );
    expect(queryClient.getQueryData(keys.toolsets)).toEqual({ browser: false });
    transport.revokeWrites();
    expect(await Promise.all(writes)).toEqual(["failed", "failed"]);
    expect(queryClient.getQueryData(keys.toolsets)).toEqual({ browser: true });
    expect(queryClient.getQueryData(keys.notifications)).toEqual({
      enabled: false,
      sound: false,
    });
    await vi.waitFor(() => expect(reads.toolsets).toHaveBeenCalledTimes(1));
    expect(reads.notifications).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls).toEqual([[enUS.chat.message.notSent]]);
    for (const stop of watched) stop();
    queryClient.clear();
  });

  it("classifies by procedure: a read without a signal waits past the write deadline, a write with one is still held", async () => {
    vi.useFakeTimers();
    const transport = create({ deadlineMs: 1000 });
    // Reads: no signal, no hold, no deadline.
    const read = transport.client.settings.get({});
    const search = transport.client.files.search({} as never);
    // A mutation with a signal is a write all the same.
    const abort = new AbortController();
    const connect = transport.client.connectors
      .connect({ id: "gmail" } as never, { signal: abort.signal })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(isHostUnavailable(await connect)).toBe(true);
    const open = socket();
    transport.attach(asSocket(open));
    await vi.advanceTimersByTimeAsync(10);
    expect(open.sent).toHaveLength(2);
    expect(open.sent.join()).toContain("settings");
    expect(open.sent.join()).toContain("search");
    expect(open.sent.join()).not.toContain("connect");
    void read.catch(() => undefined);
    void search.catch(() => undefined);
  });

  it("does not hold the host's idle clock, but waits the loaders' bot chat without a deadline", async () => {
    vi.useFakeTimers();
    const transport = create({ deadlineMs: 1000 });
    const open = socket();
    transport.attach(asSocket(open));
    void transport.client.system.activity({}).catch(() => undefined);
    const chat = transport.client.bots
      .openChat({ botId: "b1" } as never)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(open.sent).toHaveLength(1);
    expect(open.sent[0]).toContain("activity");
    transport.confirmWrites();
    await vi.advanceTimersByTimeAsync(10);
    expect(open.sent).toHaveLength(2);
    expect(open.sent[1]).toContain("openChat");
    void chat;
  });

  it("never sends a write made before a revocation, even once writes are confirmed again", async () => {
    const transport = create({ writesConfirmed: true });
    // Made under the old authorization, while no socket is open.
    const before = write(transport).catch((error: unknown) => error);
    transport.revokeWrites();
    expect(isHostUnavailable(await before)).toBe(true);
    // One made after the revocation waits for the next confirmation.
    const after = write(transport).catch((error: unknown) => error);
    const open = socket();
    transport.attach(asSocket(open));
    await flush();
    expect(open.sent).toEqual([]);
    transport.confirmWrites();
    await vi.waitFor(() => expect(open.sent).toHaveLength(1));
    void after;
  });

  it("re-checks the authorization right before dispatch, after the wait resolved", async () => {
    const transport = create();
    const open = socket();
    transport.attach(asSocket(open));
    const held = write(transport).catch((error: unknown) => error);
    await flush();
    // Released and revoked in the same task: the waiter woke, but the
    // dispatch check runs after the revocation.
    transport.confirmWrites();
    transport.revokeWrites();
    expect(isHostUnavailable(await held)).toBe(true);
    await flush();
    expect(open.sent).toEqual([]);
  });

  it("suspends writes on each replacement socket until the gate confirms again", async () => {
    const transport = create({ writesConfirmed: true });
    const first = socket();
    transport.attach(asSocket(first));
    first.close();
    const pending = write(transport).catch((error: unknown) => error);
    const second = socket();
    transport.attach(asSocket(second));
    await flush();
    expect(second.sent).toEqual([]);
    transport.confirmWrites();
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    void pending;
  });

  it("keeps one deadline per write across socket replacements", async () => {
    vi.useFakeTimers();
    const transport = create({
      writesConfirmed: true,
      reauthorize: false,
      deadlineMs: 1000,
    });
    const outcome = write(transport).catch((error: unknown) => error);
    // A socket that is already closing, then replaced, then closing again:
    // every wait resumes the same deadline instead of starting a new one.
    for (const at of [300, 300, 300]) {
      await vi.advanceTimersByTimeAsync(at);
      const closing = socket();
      closing.readyState = 2;
      transport.attach(asSocket(closing));
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(isHostUnavailable(await outcome)).toBe(true);
    const late = socket();
    transport.attach(asSocket(late));
    await vi.advanceTimersByTimeAsync(10);
    expect(late.sent).toEqual([]);
  });

  it("reports a send that found the socket closed after the check as not sent", async () => {
    const transport = create({ writesConfirmed: true });
    const racing = socket();
    let checks = 0;
    // Open for the transport's check, closed by the time oRPC sends.
    Object.defineProperty(racing, "readyState", {
      get: () => (checks++ === 0 ? 1 : 3),
    });
    transport.attach(asSocket(racing));
    const outcome = await write(transport).catch((error: unknown) => error);
    expect(isHostUnavailable(outcome)).toBe(true);
    expect(racing.sent).toEqual([]);
  });

  it("re-checks authorization at the socket write: a revocation during encoding sends nothing", async () => {
    const transport = create({ writesConfirmed: true });
    const open = socket();
    transport.attach(asSocket(open));
    // The transport's check has passed; oRPC is still encoding the frame.
    const outcome = write(transport).catch((error: unknown) => error);
    transport.revokeWrites();
    expect(isHostUnavailable(await outcome)).toBe(true);
    expect(open.sent).toEqual([]);
  });

  it("re-checks the deadline at the socket write", async () => {
    vi.useFakeTimers();
    const transport = create({ writesConfirmed: true, deadlineMs: 1000 });
    const open = socket();
    transport.attach(asSocket(open));
    const outcome = write(transport).catch((error: unknown) => error);
    vi.setSystemTime(Date.now() + 2_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(isHostUnavailable(await outcome)).toBe(true);
    expect(open.sent).toEqual([]);
  });

  it("sends a guarded write without its guard tag, and leaves reads untouched", async () => {
    const transport = create({ writesConfirmed: true });
    const open = socket();
    transport.attach(asSocket(open));
    void write(transport).catch(() => undefined);
    const abort = new AbortController();
    void transport.client.system
      .info({}, { signal: abort.signal })
      .catch(() => undefined);
    await vi.waitFor(() => expect(open.sent).toHaveLength(2));
    expect(open.sent.join()).not.toContain("x-abacus-send");
    abort.abort();
  });

  it("ignores a confirmation decided before the last suspension", async () => {
    const transport = create();
    const open = socket();
    transport.attach(asSocket(open));
    const ticket = transport.writeTicket();
    void write(transport).catch(() => undefined);
    // A replaced socket (or a credential change) suspends writes; the old
    // check's confirmation arrives afterwards.
    transport.suspendWrites();
    transport.confirmWrites(ticket);
    await flush();
    expect(open.sent).toEqual([]);
    transport.confirmWrites(transport.writeTicket());
    await vi.waitFor(() => expect(open.sent).toHaveLength(1));
  });

  it("ends a generation on drop(): its calls fail at once, the late close is ignored", async () => {
    const transport = create({ writesConfirmed: true });
    const silent = new SlowCloseSocket();
    const ended = transport.attach(asSocket(silent));
    const abort = new AbortController();
    const call = transport.client.system
      .info({}, { signal: abort.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(silent.sent).toHaveLength(1));
    transport.drop("unresponsive");
    expect(transport.state).toBe("reconnecting");
    await expect(ended).resolves.toMatchObject({ code: 4000 });
    expect(await call).toBeInstanceOf(Error);
    expect(transport.closeCode(1)).toBe(4000);
    const next = socket();
    transport.attach(asSocket(next));
    expect(transport.state).toBe("open");
    // The dropped socket's own close, much later, changes nothing.
    silent.dispatchEvent(new Event("close"));
    expect(transport.state).toBe("open");
    expect(transport.generation).toBe(2);
  });

  it("dispatches nothing on a socket that is closing, until the next one opens", async () => {
    vi.useFakeTimers();
    const transport = create({ writesConfirmed: true, reauthorize: false });
    const slow = new SlowCloseSocket();
    const ended = transport.attach(asSocket(slow));
    slow.close(1006);
    const abort = new AbortController();
    void transport.client.system
      .info({}, { signal: abort.signal })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(500);
    expect(slow.sent).toEqual([]);
    expect(transport.state).toBe("open");
    await vi.advanceTimersByTimeAsync(600);
    await expect(ended).resolves.toMatchObject({ code: 1006 });
    expect(transport.state).toBe("reconnecting");
    const next = socket();
    transport.attach(asSocket(next));
    await vi.advanceTimersByTimeAsync(10);
    expect(next.sent).toHaveLength(1);
    abort.abort();
  });

  it("never sends on a closing socket: the call waits for the next one", async () => {
    const transport = create({ writesConfirmed: true });
    const closing = socket();
    transport.attach(asSocket(closing));
    // The browser flips readyState before the close event reaches us.
    closing.readyState = 2;
    const abort = new AbortController();
    void transport.client.system
      .info({}, { signal: abort.signal })
      .catch(() => undefined);
    await flush();
    expect(closing.sent).toEqual([]);
    closing.close();
    const next = socket();
    transport.attach(asSocket(next));
    await vi.waitFor(() => expect(next.sent.length).toBe(1));
    abort.abort();
  });

  it("fails waiting calls as not sent when it closes for good", async () => {
    const transport = create({ writesConfirmed: true });
    const abort = new AbortController();
    const waiting = transport.client.system
      .info({}, { signal: abort.signal })
      .catch((error: unknown) => error);
    const closed = vi.fn();
    transport.onClose(closed);
    transport.fail();
    expect(transport.state).toBe("closed");
    expect(isHostUnavailable(await waiting)).toBe(true);
    expect(closed).toHaveBeenCalledWith("port-closed");
    const late = socket();
    transport.attach(asSocket(late));
    expect(late.close).toHaveBeenCalled();
  });
});

describe("followNotices over generations (spec 09 D3)", () => {
  it("waits for the first socket, then reopens on every new generation", async () => {
    const transport = create();
    const opened: number[] = [];
    const ends: Array<() => void> = [];
    const abort = new AbortController();
    const done = followNotices(
      transport,
      async () => {
        opened.push(transport.generation);
        return (async function* () {
          yield transport.generation;
          await new Promise<void>((resolve) => ends.push(resolve));
          throw new Error("socket closed");
        })();
      },
      () => undefined,
      abort.signal
    );
    await flush();
    expect(opened).toEqual([]);
    const first = socket();
    transport.attach(asSocket(first));
    await vi.waitFor(() => expect(opened).toEqual([1]));
    first.close();
    ends.shift()?.();
    await flush();
    // Reconnecting: the loop waits instead of exiting.
    expect(opened).toEqual([1]);
    transport.attach(asSocket(socket()));
    await vi.waitFor(() => expect(opened).toEqual([1, 2]));
    abort.abort();
    ends.shift()?.();
    await done;
  });

  it("stops when the transport closes for good", async () => {
    const transport = create();
    const done = followNotices(
      transport,
      async () => (async function* () {})(),
      () => undefined,
      new AbortController().signal
    );
    transport.fail();
    await expect(done).resolves.toBeUndefined();
  });
});
