import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

const bringToFront = vi.fn();
vi.mock("../../bring-to-front", () => ({ bringToFront: () => bringToFront() }));

const apiKey = vi.fn(() => "test-key");
vi.mock("../config/settings", () => ({
  credentialFor: (name: string) => (name === "ABACUS_API_KEY" ? apiKey() : ""),
}));

const {
  buildConnectorsSnapshot,
  cancelConnectorConnect,
  disconnectAbacusConnector,
  listAbacusConnectors,
  startConnectorConnect,
} = await import("./abacus-connector-service");

/**
 * One platform reply, in the envelope the API actually uses. `null` stands for
 * a call that fails outright — a 500, or the network being down.
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
  it("maps the platform catalog and active connectors to the renderer shape", () => {
    const snapshot = buildConnectorsSnapshot(
      {
        GMAILUSER: { name: "Gmail" },
        SLACK: { name: "Slack" },
        // Name absent -> falls back to the service key.
        YOUTUBE: {},
        // The platform's GitHub: never offered here, the GitHub card is a token.
        GITHUBUSER: { name: "GitHub" },
      },
      [
        { service: "SLACK", applicationConnectorId: "1a2b3c" },
        { service: "gmailuser", applicationConnectorId: "4d5e6f" },
        // Attached on the account, still not reported: nothing here uses it.
        { service: "GITHUBUSER", applicationConnectorId: "7g8h9i" },
        // Rows without an id (or service) are ignored rather than guessed at.
        { service: "JIRA" },
        { applicationConnectorId: "orphan" },
      ]
    );

    expect(snapshot.ok).toBe(true);
    expect(snapshot.available).toEqual([
      { service: "gmailuser", name: "Gmail" },
      { service: "slack", name: "Slack" },
      { service: "youtube", name: "YOUTUBE" },
    ]);
    expect(snapshot.connected).toEqual({
      slack: "1a2b3c",
      gmailuser: "4d5e6f",
    });
  });

  /**
   * The platform names an attachment after the account behind it. Dropping
   * that name left the agent unable to say who the user is on a service they
   * had just connected — it asked them for their own Gmail address.
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
    // delete and then goes unreachable used to be reported as a failure — for
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
    // read back as a truthy connector id — enough to send a junk delete to the
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
 * window is in a Space of its own — so opening the browser moves them out of
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
