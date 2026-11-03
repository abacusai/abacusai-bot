/**
 * A session removed from the phone must be noticed.
 *
 * The report: a tester unlinked WhatsApp from their phone, and the app kept
 * saying Connected while every send and read hit a logged-out page. The
 * signed-out branch of checkLogin existed, but the login poll was cleared
 * the moment the connector reported connected, so nothing ever ran it.
 *
 * Pinned here: the poll keeps answering after connect (a signed-out page
 * flips the state to needs_login), and the flip is debounced by what the
 * page positively shows: a QR screen is believed after four polls in a
 * row, while a page showing neither the QR nor the chat list is WhatsApp
 * booting (the connector's own /send?phone= navigations reload the whole
 * SPA) and has to stay that way for forty. Wiping the link on a slow boot
 * re-armed the self lookup, whose navigation caused the next slow boot: a
 * connected↔needs_login flap that read as "chats never sync".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: {
      getPath: () => "/user-data",
      getPreferredSystemLanguages: () => [],
      getLocale: () => "en-US",
    },
    BrowserWindow: class {},
    session: { fromPartition: () => ({}) },
    shell: { openExternal: async () => undefined },
    powerMonitor: new EventEmitter(),
    net: { isOnline: () => true },
  };
});

/** The bytes free on the app's disk, as the lane measures it. */
const disk = vi.hoisted(() => ({ free: 0 }));
vi.mock("@abacus-ai/agent/atomic-file", async (importActual) => ({
  ...(await importActual<typeof import("@abacus-ai/agent/atomic-file")>()),
  freeBytes: () => disk.free,
}));

const { powerMonitor } = await import("electron");
const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");

/** The connector with the page's login answers scripted; no Electron. */
const connectorSeeing = (
  loginStates: Array<{ loggedIn: boolean; loginVisible?: boolean }>
): {
  poll: () => Promise<void>;
  states: string[];
} => {
  const states: string[] = [];
  const connector = new WhatsAppWebConnector({
    onMessage: () => {},
    onState: (state: string) => states.push(state),
    onLog: () => {},
  } as never);

  const queue = [...loginStates];
  const internals = connector as unknown as {
    running: boolean;
    run: (script: string, args: unknown) => Promise<unknown>;
    checkLogin: () => Promise<void>;
    startInboundPolling: () => void;
    refreshContacts: () => Promise<void>;
    window: unknown;
  };
  internals.running = true;
  internals.run = async () => queue.shift() ?? null;
  // The connected transition starts the sweep; neither belongs in this test.
  internals.startInboundPolling = () => {};
  internals.refreshContacts = async () => {};

  return {
    // A macrotask flush after the connecting poll: the connected branch now
    // kicks off a SERIALIZED contacts refresh, and the login poll skips
    // ticks while any serialized task is driving the page; the flush lets
    // the (stubbed) task finish so later polls are judged, not skipped.
    poll: async () => {
      await internals.checkLogin();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    states,
  };
};

describe("a login that goes away after connect", () => {
  it("is reported as needs_login by the ongoing poll", async () => {
    const { poll, states } = connectorSeeing([
      { loggedIn: true },
      { loggedIn: false, loginVisible: true },
      { loggedIn: false, loginVisible: true },
      { loggedIn: false, loginVisible: true },
      { loggedIn: false, loginVisible: true },
    ]);

    await poll(); // connects
    await poll(); // QR readings, debounced...
    await poll();
    await poll();
    await poll(); // ...fourth in a row, believed

    expect(states).toEqual(["connected", "needs_login"]);
  });

  it("waits out a boot screen instead of reporting an unlink", async () => {
    // Neither the QR nor the chat list: the page is booting, which is what
    // every connector-initiated navigation looks like for a while. Four in
    // a row must NOT be believed the way a QR is.
    const { poll, states } = connectorSeeing([
      { loggedIn: true },
      ...Array.from({ length: 10 }, () => ({ loggedIn: false })),
      { loggedIn: true },
    ]);

    await poll(); // connects
    for (let i = 0; i < 10; i += 1) await poll(); // boot drags on, waited out
    await poll(); // the boot finishes

    expect(states).toEqual(["connected"]);
  });

  it("shrugs off a single mid-reload misreading", async () => {
    const { poll, states } = connectorSeeing([
      { loggedIn: true },
      { loggedIn: false },
      { loggedIn: true },
      { loggedIn: false },
    ]);

    await poll(); // connects
    await poll(); // transient signed-out, debounced
    await poll(); // healthy again, debounce reset
    await poll(); // another lone signed-out, still debounced

    expect(states).toEqual(["connected"]);
  });
});

/**
 * Sleep and wake. The report: after the PC slept, the bridge never came
 * back; the 5s sweep kept queueing behind 30s attach waits on one page lock,
 * and a chat read waited behind dozens of them until the agent's client gave
 * up at fifteen minutes. Pinned: one relink at a time on a backoff, no sweep
 * while it runs, and a read that answers inside its deadline either way.
 */
describe("a computer that sleeps and wakes", () => {
  afterEach(() => {
    vi.useRealTimers();
    powerMonitor.removeAllListeners();
  });

  type Wired = {
    running: boolean;
    loggedIn: boolean;
    bridgeReady: boolean;
    bridgeExpected: boolean;
    selfLookupDone: boolean;
    chatListRead: boolean;
    bridgeChats: unknown[];
    bridge: unknown;
    window: unknown;
    userDeadlineMs: number;
    run: (script: string, args: unknown) => Promise<unknown>;
    reloadPage: () => Promise<void>;
    watchPower: () => void;
    startInboundPolling: () => void;
    readChat: (chatId: string, limit: number) => Promise<unknown[]>;
    lock: { busy: boolean };
  };

  /** A linked connector whose bridge fails to re-attach `failures` times. */
  const wired = (failures: number) => {
    const states: string[] = [];
    const connector = new WhatsAppWebConnector({
      onMessage: () => {},
      onState: (state: string) => states.push(state),
      onLog: () => {},
    } as never);
    const c = connector as unknown as Wired;
    const counts = { sweeps: 0, attaches: 0, reloads: 0, overlap: 0 };
    let holding = 0;
    let live = true;
    const hold = async <T>(answer: T): Promise<T> => {
      holding += 1;
      counts.overlap = Math.max(counts.overlap, holding);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      holding -= 1;
      return answer;
    };
    c.running = true;
    c.loggedIn = true;
    c.bridgeReady = true;
    c.bridgeExpected = true;
    c.selfLookupDone = true;
    c.chatListRead = true;
    const ma = { jid: "919111111111@c.us", name: "Ma", isGroup: false };
    c.bridgeChats = [ma];
    // The page itself shows the chat list; the bridge is what went away.
    c.run = async () => ({ loggedIn: true });
    c.reloadPage = async () => {
      counts.reloads += 1;
    };
    c.bridge = {
      isLive: async () => live,
      ensure: async () => {
        counts.attaches += 1;
        live = counts.attaches > failures;
        return hold(live);
      },
      listChats: async () => [ma],
      drain: async () => {
        counts.sweeps += 1;
        return hold({ messages: [], loggedOut: false });
      },
      readChat: async () => ({
        ok: true,
        rows: [{ id: "1", jid: ma.jid, fromMe: false, text: "hi", t: 1 }],
      }),
    };
    c.watchPower();
    c.startInboundPolling();
    return { c, states, counts, detach: () => (live = false) };
  };

  it("relinks once on a backoff, sweeps nothing meanwhile, and reads fail fast until it is back", async () => {
    vi.useFakeTimers();
    const { c, states, counts, detach } = wired(2);

    // Awake: a 2s sweep every 5s, one at a time.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(counts.sweeps).toBeGreaterThanOrEqual(4);
    expect(counts.overlap).toBe(1);

    powerMonitor.emit("suspend");
    detach();
    const sweepsBeforeSleep = counts.sweeps;
    await vi.advanceTimersByTimeAsync(60_000);
    powerMonitor.emit("resume");
    // A second wake signal (unlock) joins the relink already under way.
    powerMonitor.emit("unlock-screen");

    // Mid-relink: the read waits on the attempt, then answers with the state.
    const started = Date.now();
    const during = c.readChat("Ma", 10).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await during).toMatch(
      /reconnecting after the computer woke up\. Try again in a moment/
    );
    expect(Date.now() - started).toBeLessThanOrEqual(c.userDeadlineMs);
    expect(states).toEqual(["connecting"]);
    expect(counts.sweeps).toBe(sweepsBeforeSleep);

    // Two more tries on the backoff; the third attach lands.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(counts.attaches).toBe(3);
    expect(counts.reloads).toBe(2);
    expect(states).toEqual(["connecting", "connecting", "connected"]);
    // Never two page tasks at once.
    expect(counts.overlap).toBe(1);

    // Back: the read goes ahead of any sweep and answers.
    const after = c.readChat("Ma", 10);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(after).resolves.toEqual([
      expect.objectContaining({ text: "hi", direction: "in" }),
    ]);
  });

  it("cuts a read short at its deadline and gives the page back", async () => {
    vi.useFakeTimers();
    const { c } = wired(0);
    (c as unknown as { inboundPoll: { stop: () => void } }).inboundPoll.stop();
    c.userDeadlineMs = 5_000;
    // A renderer that never answers the read; everything else answers.
    let answered = 0;
    c.window = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: (code: string) =>
          code.includes("HANG")
            ? new Promise(() => {})
            : Promise.resolve((answered += 1)),
      },
    };
    const realRun = Object.getPrototypeOf(c).run as Wired["run"];
    c.run = realRun.bind(c);
    (c.bridge as { readChat: unknown }).readChat = async () => ({
      ok: true,
      rows: (await c.run("HANG", {})) ?? [],
    });

    const stuck = c.readChat("Ma", 10).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await stuck).toMatch(/did not answer within 5s/);
    // The lock is free again: the next page call is not stuck behind it.
    await vi.advanceTimersByTimeAsync(0);
    expect(c.lock.busy).toBe(false);
    await expect(c.run("ANSWER", {})).resolves.toBe(answered);
  });
});

describe("a page whose storage finds the disk full", () => {
  afterEach(() => vi.useRealTimers());

  it("leaves connected for the full-disk error, and loads a fresh page by itself once space is back", async () => {
    vi.useFakeTimers();
    const states: Array<[string, string | undefined]> = [];
    const connector = new WhatsAppWebConnector({
      onMessage: () => {},
      onState: (state: string, note?: string) => states.push([state, note]),
      onLog: () => {},
    } as never);
    const c = connector as unknown as {
      running: boolean;
      loggedIn: boolean;
      window: unknown;
      run: (script: string, args: unknown) => Promise<unknown>;
      ensureWindow: () => unknown;
    };
    c.running = true;
    c.loggedIn = true;
    let destroyed = false;
    // WhatsApp Web's own IndexedDB open, as the page reports it on a full disk.
    c.window = {
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true;
      },
      webContents: {
        executeJavaScript: () =>
          Promise.reject(
            new Error(
              "QuotaExceededError Encountered full disk while opening backing store for indexedDB.open."
            )
          ),
      },
    };
    disk.free = 0;

    await expect(c.run("ANY", {})).resolves.toBeNull();
    expect(states).toEqual([
      [
        "error",
        "The computer's disk is full, so WhatsApp can't save its data. It reconnects by itself once some space is freed.",
      ],
    ]);
    expect(destroyed).toBe(true);
    // Another script failing the same way says nothing new.
    await c.run("ANY", {});
    expect(states).toHaveLength(1);

    // Not enough yet: the lane keeps waiting.
    const reload = vi.fn(() => null);
    c.ensureWindow = reload;
    disk.free = 10 * 1024 ** 2;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reload).not.toHaveBeenCalled();

    // Space is back: a fresh page, checked again, with no click.
    disk.free = 5 * 1024 ** 3;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states.at(-1)).toEqual(["connecting", undefined]);
    expect(reload).toHaveBeenCalled();
    await connector.stop();
  });
});
