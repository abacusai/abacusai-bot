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
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));

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
