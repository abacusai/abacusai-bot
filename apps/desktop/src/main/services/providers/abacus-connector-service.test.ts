import http from "http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));
const sessionHolds = vi.hoisted(() => vi.fn(async () => false));
vi.mock("./sign-in-session", () => ({ sessionHolds }));
vi.mock("./account-service", () => ({
  readAccountState: () => ({ account: { email: "me@example.com" } }),
}));
const openConnectWindow = vi.hoisted(() =>
  vi.fn<
    (options: {
      url: string;
      onDismissed: () => void;
    }) => { close: () => void } | null
  >(() => null)
);
vi.mock("./abacus-connect-window", () => ({ openConnectWindow }));

const bringToFront = vi.fn();
vi.mock("../../bring-to-front", () => ({ bringToFront: () => bringToFront() }));

const apiKey = vi.fn(() => "test-key");
vi.mock("../config/settings", () => ({
  credentialFor: (name: string) => (name === "ABACUS_API_KEY" ? apiKey() : ""),
}));

const {
  cancelAllConnectorConnects,
  buildConnectorsSnapshot,
  cancelConnectorConnect,
  createConnectLink,
  disconnectAbacusConnector,
  listAbacusConnectors,
  startConnectorConnect,
} = await import("./abacus-connector-service");

/**
 * One platform reply, in the envelope the API actually uses. `null` stands for
 * a call that fails outright: a 500, or the network being down.
 */
type Reply = { success: true; result: unknown } | null;

let replies: Map<string, Reply[]>;
let calls: string[];

const method = (url: string): string =>
  new URL(url).pathname.replace("/api/v1/", "");

/** Queue what each method returns, call by call. */
const answer = (name: string, ...queued: Reply[]): void => {
  replies.set(name, queued);
};

beforeEach(() => {
  replies = new Map();
  calls = [];
  apiKey.mockReturnValue("test-key");

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const name = method(String(input));
      calls.push(name);
      const queue = replies.get(name) ?? [];
      const reply = queue.length > 1 ? queue.shift() : queue[0];

      if (reply == null) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false }),
        } as unknown as Response);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(reply),
      } as unknown as Response);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildConnectorsSnapshot", () => {
  it("maps the platform catalog and active connectors to the app's shape, registry services only", () => {
    const snapshot = buildConnectorsSnapshot(
      {
        GMAILUSER: { name: "Gmail" },
        SLACK: { name: "Slack" },
        // Not in the registry: the platform offers it, this app does not.
        YOUTUBE: {},
        // The platform's GitHub: never offered here, the GitHub card is a token.
        GITHUBUSER: { name: "GitHub" },
      },
      [
        { service: "SLACK", applicationConnectorId: "1a2b3c" },
        { service: "gmailuser", applicationConnectorId: "4d5e6f" },
        // Attached on the account, still not reported: nothing here uses it.
        { service: "GITHUBUSER", applicationConnectorId: "7g8h9i" },
        { service: "youtube", applicationConnectorId: "0j1k2l" },
        // Rows without an id (or service) are ignored rather than guessed at.
        { service: "JIRA" },
        { applicationConnectorId: "orphan" },
      ]
    );

    expect(snapshot.ok).toBe(true);
    expect(snapshot.available).toEqual([
      { service: "gmailuser", name: "Gmail" },
      { service: "slack", name: "Slack" },
    ]);
    expect(snapshot.connected).toEqual({
      slack: "1a2b3c",
      gmailuser: "4d5e6f",
    });
  });

  /**
   * The platform names an attachment after the account behind it. Dropping
   * that name left the agent unable to say who the user is on a service they
   * had just connected. It asked them for their own Gmail address.
   */
  it("keeps who each connector is connected as", () => {
    const snapshot = buildConnectorsSnapshot(
      { GMAILUSER: { name: "Gmail" }, SLACK: { name: "Slack" } },
      [
        {
          service: "GMAILUSER",
          name: "Gmail - ada@example.com",
          applicationConnectorId: "4d5e6f",
        },
        // No name on the row: connected, just anonymous.
        { service: "SLACK", applicationConnectorId: "1a2b3c" },
      ]
    );

    expect(snapshot.accounts).toEqual({
      gmailuser: "Gmail - ada@example.com",
    });
  });

  it("tolerates malformed payloads", () => {
    const snapshot = buildConnectorsSnapshot(null, "nonsense");
    expect(snapshot).toEqual({
      ok: true,
      available: [],
      connected: {},
      accounts: {},
    });
  });

  it("does not answer to names it inherited from Object.prototype", () => {
    // The keys are service names off the wire. On a plain object literal,
    // "constructor" reads back as a truthy connector id and every caller that
    // asks "is this connected?" is told yes.
    const snapshot = buildConnectorsSnapshot({}, []);

    expect(snapshot.connected.constructor).toBeUndefined();
    expect(snapshot.connected.toString).toBeUndefined();
  });
});

describe("disconnecting a connector", () => {
  const connected = (...services: string[]): Reply => ({
    success: true,
    result: services.map((service) => ({
      service,
      applicationConnectorId: `id-${service}`,
    })),
  });

  const catalog: Reply = {
    success: true,
    result: { SLACK: { name: "Slack" } },
  };

  it("reports success when the connector is gone afterwards", async () => {
    answer("_listValidAgentConnectors", catalog);
    answer("_listActiveUserLevelConnectors", connected("slack"), {
      success: true,
      result: [],
    });
    answer("_deleteUserConnector", { success: true, result: null });

    expect(await disconnectAbacusConnector("slack")).toEqual({ ok: true });
  });

  it("reports success when the delete worked but the confirming list is unavailable", async () => {
    // A successful DELETE carries a null result, so a service that answers the
    // delete and then goes unreachable used to be reported as a failure, for
    // a connector that had in fact just been removed.
    answer("_listValidAgentConnectors", catalog, null);
    answer("_listActiveUserLevelConnectors", connected("slack"), null);
    answer("_deleteUserConnector", { success: true, result: null });

    expect(await disconnectAbacusConnector("slack")).toEqual({ ok: true });
  });

  it("reports failure when the delete failed and nothing can confirm it", async () => {
    answer("_listValidAgentConnectors", catalog, null);
    answer("_listActiveUserLevelConnectors", connected("slack"), null);
    answer("_deleteUserConnector", null);

    expect(await disconnectAbacusConnector("slack")).toEqual({
      ok: false,
      error: "Could not disconnect. Please try again.",
    });
  });

  it("reports failure when the connector is still listed afterwards", async () => {
    answer("_listValidAgentConnectors", catalog);
    answer("_listActiveUserLevelConnectors", connected("slack"));
    answer("_deleteUserConnector", { success: true, result: null });

    expect(await disconnectAbacusConnector("slack")).toEqual({
      ok: false,
      error: "Could not disconnect. Please try again.",
    });
  });

  it("refuses a service name that could not be a platform key", async () => {
    // The same check the connect side applies, which disconnect skipped.
    expect(await disconnectAbacusConnector("has spaces")).toEqual({
      ok: false,
      error: "Unknown connector.",
    });
    expect(await disconnectAbacusConnector("x")).toEqual({
      ok: false,
      error: "Unknown connector.",
    });
    expect(calls).toEqual([]);
  });

  it("does not mistake an inherited property for a connected service", async () => {
    // "constructor" is a legal-looking service name, and on a plain object it
    // read back as a truthy connector id, enough to send a junk delete to the
    // platform for a connector nobody has.
    answer("_listValidAgentConnectors", catalog);
    answer("_listActiveUserLevelConnectors", connected("slack"));

    expect(await disconnectAbacusConnector("constructor")).toEqual({
      ok: false,
      error: "This service is not connected.",
    });
    expect(calls).not.toContain("_deleteUserConnector");
  });

  it("says so for a service that is simply not connected", async () => {
    answer("_listValidAgentConnectors", catalog);
    answer("_listActiveUserLevelConnectors", connected("gmailuser"));

    expect(await disconnectAbacusConnector("slack")).toEqual({
      ok: false,
      error: "This service is not connected.",
    });
    expect(calls).not.toContain("_deleteUserConnector");
  });
});

describe("listing connectors without a key", () => {
  it("says which of the two problems it is, so the panel can offer sign-in", async () => {
    apiKey.mockReturnValue("");

    expect(await listAbacusConnectors()).toEqual({
      ok: false,
      error: "not-signed-in",
      available: [],
      connected: {},
      accounts: {},
    });
  });
});

/**
 * The sign-in happens in the user's own browser, and on macOS a full-screen
 * window is in a Space of its own, so opening the browser moves them out of
 * the app. Nothing moved them back, and what they were left looking at was a
 * bare Space and an app they had to go and find.
 */
describe("coming back from the browser hop", () => {
  it("puts the app in front once the hop settles", async () => {
    bringToFront.mockClear();
    const hop = startConnectorConnect("slack");

    expect(bringToFront).not.toHaveBeenCalled();

    cancelConnectorConnect();
    await hop;

    expect(bringToFront).toHaveBeenCalledOnce();
  });

  it("does not reveal for a connector it never opened the browser for", async () => {
    bringToFront.mockClear();

    await startConnectorConnect("not a service");

    expect(bringToFront).not.toHaveBeenCalled();
  });
});

describe("how the browser hop starts", () => {
  // The service awaits the open's promise; the module mock's bare vi.fn() has none.
  const openResolves = async (): Promise<void> => {
    const { shell } = await import("electron");
    (
      shell.openExternal as unknown as {
        mockResolvedValue: (value: unknown) => void;
      }
    ).mockResolvedValue(undefined);
  };
  const openedUrl = async (): Promise<URL> => {
    const { shell } = await import("electron");
    const calls = (
      shell.openExternal as unknown as { mock: { calls: string[][] } }
    ).mock.calls;
    return new URL(calls[calls.length - 1]?.[0] ?? "");
  };

  it("asks the connect page to start on load with the account pre-selected", async () => {
    await openResolves();
    const hop = startConnectorConnect("gmailuser", {
      autostart: true,
      hint: "someone@gmail.com",
    });
    await vi.waitFor(async () =>
      expect((await openedUrl()).searchParams.get("service")).toBe("gmailuser")
    );
    const url = await openedUrl();
    expect(url.pathname).toBe("/chatllm/connect-connector");
    expect(url.searchParams.get("autostart")).toBe("1");
    expect(url.searchParams.get("hint")).toBe("someone@gmail.com");
    cancelConnectorConnect();
    await hop;
  });

  it("leaves a plain click alone, and drops a hint that is not an email", async () => {
    await openResolves();
    const hop = startConnectorConnect("slack", { hint: "not an email" });
    await vi.waitFor(async () =>
      expect((await openedUrl()).searchParams.get("service")).toBe("slack")
    );
    const url = await openedUrl();
    expect(url.searchParams.has("autostart")).toBe(false);
    expect(url.searchParams.has("hint")).toBe(false);
    cancelConnectorConnect();
    await hop;
  });
});

/**
 * The account that signed in inside the app has its session in the app's
 * sign-in window, not the browser. The connect page in the browser would
 * show its own sign-in first; on that session it goes straight to the
 * provider.
 */
describe("where the hop runs", () => {
  beforeEach(() => {
    sessionHolds.mockResolvedValue(false);
    openConnectWindow.mockReset();
    openConnectWindow.mockReturnValue(null);
  });

  it("runs in an app window on the sign-in session when the account signed in there", async () => {
    sessionHolds.mockResolvedValue(true);
    const close = vi.fn();
    openConnectWindow.mockReturnValue({ close });
    const { shell } = await import("electron");
    (shell.openExternal as unknown as { mockClear: () => void }).mockClear();

    const hop = startConnectorConnect("gmailuser", { autostart: true });
    await vi.waitFor(() => expect(openConnectWindow).toHaveBeenCalledOnce());
    const url = new URL(openConnectWindow.mock.calls[0]![0].url);
    expect(url.pathname).toBe("/chatllm/connect-connector");
    expect(url.searchParams.get("autostart")).toBe("1");
    expect(shell.openExternal).not.toHaveBeenCalled();

    cancelConnectorConnect();
    await hop;
    expect(close).toHaveBeenCalledOnce();
  });

  it("is cancelled when the user closes that window", async () => {
    sessionHolds.mockResolvedValue(true);
    openConnectWindow.mockReturnValue({ close: vi.fn() });

    const hop = startConnectorConnect("gmailuser");
    await vi.waitFor(() => expect(openConnectWindow).toHaveBeenCalledOnce());
    openConnectWindow.mock.calls[0]![0].onDismissed();

    expect(await hop).toMatchObject({ ok: false, cancelled: true });
  });

  it("falls back to the browser without a session, or without an app window", async () => {
    const { shell } = await import("electron");
    (shell.openExternal as unknown as { mockClear: () => void }).mockClear();
    (
      shell.openExternal as unknown as {
        mockResolvedValue: (v: unknown) => void;
      }
    ).mockResolvedValue(undefined);
    sessionHolds.mockResolvedValue(true);
    openConnectWindow.mockReturnValue(null);

    const hop = startConnectorConnect("slack");
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledOnce());
    cancelConnectorConnect();
    await hop;
  });
});

/**
 * Hops are owned. A screen leaving cancels the hops it started on a click;
 * the hop onboarding starts on the user's behalf outlives the screens, since
 * it runs once per install and the Connectors step's cleanup once took it
 * down for good.
 */
describe("who may cancel a hop", () => {
  beforeEach(() => {
    sessionHolds.mockResolvedValue(false);
  });

  it("a screen's cancel leaves the first-run hop alone, and takes its own down", async () => {
    const { shell } = await import("electron");
    (shell.openExternal as unknown as { mockClear: () => void }).mockClear();
    (
      shell.openExternal as unknown as {
        mockResolvedValue: (v: unknown) => void;
      }
    ).mockResolvedValue(undefined);
    const auto = startConnectorConnect("gmailuser", {
      autostart: true,
      owner: "first-run",
    });
    const clicked = startConnectorConnect("slack");
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalledTimes(2));

    cancelConnectorConnect();
    expect(await clicked).toMatchObject({ cancelled: true });

    let settled = false;
    void auto.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    cancelConnectorConnect("first-run");
    expect(await auto).toMatchObject({ cancelled: true });
  });

  it("the same service again supersedes; sign-out takes every hop down", async () => {
    const { shell } = await import("electron");
    const first = startConnectorConnect("slack");
    const second = startConnectorConnect("slack");
    expect(await first).toMatchObject({ cancelled: true });

    const auto = startConnectorConnect("gmailuser", { owner: "first-run" });
    await vi.waitFor(() => expect(shell.openExternal).toHaveBeenCalled());
    cancelAllConnectorConnects();
    expect(await second).toMatchObject({ cancelled: true });
    expect(await auto).toMatchObject({ cancelled: true });
  });
});

describe("the app window closed after the provider answered", () => {
  it("is not a cancel: the hop waits for the platform's confirmation", async () => {
    cancelAllConnectorConnects();
    sessionHolds.mockResolvedValue(true);
    openConnectWindow.mockReset();
    openConnectWindow.mockReturnValue({ close: vi.fn() });
    const hop = startConnectorConnect("gmailuser");
    await vi.waitFor(() => expect(openConnectWindow).toHaveBeenCalledOnce());
    const options = openConnectWindow.mock.calls[0]![0];

    // The platform lists the connector as attached once asked.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const result = url.includes("_listActiveUserLevelConnectors")
        ? [{ service: "GMAILUSER", applicationConnectorId: "abc" }]
        : { GMAILUSER: { name: "Gmail" } };
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      // The loopback ping lands, then the user closes the window.
      const url = new URL(options.url);
      const port = url.searchParams.get("botPort");
      const callbackPath = url.searchParams.get("botPath");
      await new Promise<void>((resolve, reject) => {
        http
          .get(
            `http://127.0.0.1:${port}/${callbackPath}?service=gmailuser&status=ok`,
            (res) => {
              res.resume();
              res.on("end", resolve);
            }
          )
          .on("error", reject);
      });
      options.onDismissed();

      expect(await hop).toEqual({ ok: true });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("a one-tap connect link", () => {
  it("is the server's own link, whose preview card names the service, and covers Google in one consent", async () => {
    answer("_createAbacusbotConnectLink", {
      success: true,
      result: {
        requestId: "req_0123456789abcdef",
        services: ["gmailuser", "googledriveuser", "googlecalendar"],
        url: "https://abacus.ai/app/connect/google?r=req_0123456789abcdef",
      },
    });

    expect(await createConnectLink("googlecalendar")).toEqual({
      url: "https://abacus.ai/app/connect/google?r=req_0123456789abcdef",
      services: ["gmailuser", "googledriveuser", "googlecalendar"],
    });
  });

  it("falls back to the connect page itself for a server that names no link", async () => {
    answer("_createAbacusbotConnectLink", {
      success: true,
      result: { requestId: "req_0123456789abcdef", services: ["slack"] },
    });

    const link = await createConnectLink("slack");
    expect(link?.url).toContain(
      "/chatllm/connect-connector?service=slack&r=req_0123456789abcdef&autostart=1"
    );
  });

  it("never sends a link that is not https", async () => {
    answer("_createAbacusbotConnectLink", {
      success: true,
      result: {
        requestId: "req_0123456789abcdef",
        services: ["slack"],
        url: "javascript:alert(1)",
      },
    });

    expect((await createConnectLink("slack"))?.url).toContain(
      "/chatllm/connect-connector?"
    );
  });
});
