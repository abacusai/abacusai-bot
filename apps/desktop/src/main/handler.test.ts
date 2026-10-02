/**
 * Acquiring an Abacus.AI key, from the IPC layer.
 *
 * Signing out removes the connector gateway's MCP entry, so acquiring a key has
 * to put it back. Nothing else will: the entry used to be created only by
 * connecting a connector, and the connectors are already connected on the
 * account, so the cards read "connected" against a server that is not there and
 * the UI offers nothing to add it.
 *
 * Both ways in are covered, because they are meant to be one code path: the
 * browser sign-in and a key pasted into the keys panel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("./services/providers/sign-in-session", () => ({
  clearSignInSession: vi.fn(async () => undefined),
  rememberSessionAccount: vi.fn(),
}));
vi.mock("./login-item", () => ({ registerLoginItem: vi.fn() }));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
    on: () => undefined,
  },
}));

// Only the pieces this path touches are real; the rest of the app's services
// would drag the whole main process in behind them.
vi.mock("./service-host", () => ({ ServiceHost: class {} }));
vi.mock("./services/config/settings", () => ({
  readSettings: vi.fn(),
  saveApiKey: vi.fn(() => ({ apiKeys: {} })),
  setDefaultModel: vi.fn(),
  storedKeyProviders: vi.fn(),
}));
vi.mock("./services/mcp/mcp-oauth-service", () => ({
  signInToMcpServer: vi.fn(),
}));
vi.mock("./services/providers/abacus", () => ({
  abacusCredentialRejected: vi.fn(() => false),
  clearAbacusCache: vi.fn(),
  fetchAbacusAccount: vi.fn(async () => null),
}));
vi.mock("./services/providers/account-service", () => ({
  signOut: vi.fn(),
}));
vi.mock("./profile-home", () => ({
  profileKeyFor: vi.fn(() => "acct-test"),
  legacyProfileKeyFor: vi.fn(() => "ada@example.com_acme"),
  // Same profile: no switch, no relaunch (the path every test here walks).
  activateProfile: vi.fn(() => false),
  initProfileHome: vi.fn(),
}));
vi.mock("./services/providers/abacus-auth-service", () => ({
  cancelAbacusAuth: vi.fn(),
  startAbacusAuth: vi.fn(async () => ({ ok: true, key: "s2_key" })),
}));
vi.mock("./services/providers/abacus-connector-service", () => ({
  cancelAllConnectorConnects: vi.fn(),
  cancelConnectorConnect: vi.fn(),
  disconnectAbacusConnector: vi.fn(),
  listAbacusConnectors: vi.fn(),
  startConnectorConnect: vi.fn(),
}));
vi.mock("./services/providers/models", () => ({
  listAvailableModels: vi.fn(async () => []),
}));
vi.mock("./services/providers/openrouter", () => ({
  clearOpenRouterCache: vi.fn(),
}));
vi.mock("./services/providers/openrouter-auth-service", () => ({
  startOpenRouterAuth: vi.fn(),
}));
vi.mock("./services/providers/usage", () => ({ getUsageSnapshot: vi.fn() }));

import { IpcChannels } from "#shared/channels";
import { ABACUS_CONNECTORS_SERVER_NAME } from "#shared/contracts";

import { registerIpcHandlers } from "./handler";
import { activateProfile, profileKeyFor } from "./profile-home";
import { mainEventBus } from "./rpc/event-bus";
import { readSettings, saveApiKey } from "./services/config/settings";
import {
  abacusCredentialRejected,
  fetchAbacusAccount,
} from "./services/providers/abacus";

const createBot = vi.fn();
const updateBot = vi.fn();
const ensureMcpServer = vi.fn();
const removeMcpServer = vi.fn();
const refreshAgentProviders = vi.fn();
const restoreSessionsForAccount = vi.fn(() => 0);
const stashSessionsForAccount = vi.fn(() => 0);
const startDeviceStream = vi.fn(
  async (_request: unknown, _sender: Electron.WebContents) => ({
    success: true,
    streamId: 7,
  })
);

beforeEach(() => {
  handlers.clear();
  createBot.mockReset();
  updateBot.mockReset();
  ensureMcpServer.mockClear();
  removeMcpServer.mockClear();
  restoreSessionsForAccount.mockClear();
  stashSessionsForAccount.mockClear();
  vi.mocked(profileKeyFor).mockClear();
  vi.mocked(activateProfile).mockClear();
  vi.mocked(activateProfile).mockReturnValue(false);
  vi.mocked(readSettings).mockReturnValue({ apiKeys: {} } as never);
  vi.mocked(saveApiKey).mockClear();
  vi.mocked(abacusCredentialRejected).mockReturnValue(false);
  vi.mocked(fetchAbacusAccount).mockResolvedValue({
    email: "ada@example.com",
  } as never);

  refreshAgentProviders.mockClear();

  const host = {
    createBot,
    updateBot,
    restoreSessionsForAccount,
    stashSessionsForAccount,
    setEventDispatcher: vi.fn(),
    setBusDispatcher: vi.fn(),
    setCredentialSaver: vi.fn(),
    ensureMcpServer,
    removeMcpServer,
    refreshAgentProviders,
    syncLogsNow: vi.fn(),
    startDeviceStream,
  };

  registerIpcHandlers(
    host as unknown as Parameters<typeof registerIpcHandlers>[0]
  );
  // Startup reconciles the derived gateway from the stored credential. Each
  // case below asserts only the transition it triggers.
  ensureMcpServer.mockClear();
  removeMcpServer.mockClear();
});

describe("a device stream started over legacy IPC", () => {
  it("delivers each chunk to the legacy channel and to the oRPC bus", async () => {
    const send = vi.fn();
    const sender = { id: 3, send, isDestroyed: () => false };
    await handlers.get("agent:start-device-stream")?.(
      { sender },
      { platform: "android", deviceId: "emulator-5554" }
    );
    const given = startDeviceStream.mock.calls.at(-1)![1];

    const published: unknown[] = [];
    const stop = mainEventBus.listenChannel("device-chunk", (chunk) =>
      published.push(chunk)
    );
    const chunk = {
      streamId: 7,
      data: new Uint8Array([1]),
      isKey: true,
      format: "h264",
    };
    given.send("agent:device-stream-chunk", chunk);
    given.send("something-else", 1);
    stop();

    expect(send.mock.calls).toEqual([
      ["agent:device-stream-chunk", chunk],
      ["something-else", 1],
    ]);
    expect(published).toEqual([chunk]);
    expect(given.isDestroyed()).toBe(false);
  });
});

describe("acquiring an Abacus.AI key", () => {
  const gateway = {
    mode: "code",
    name: ABACUS_CONNECTORS_SERVER_NAME,
  };

  it("re-establishes the connector gateway when signing in through the browser", async () => {
    await handlers.get(IpcChannels.StartAbacusAuth)?.({});

    expect(ensureMcpServer).toHaveBeenCalledTimes(1);
    expect(ensureMcpServer.mock.calls[0]?.[0]).toMatchObject(gateway);
  });

  it("tells the running agents to re-read the keys", async () => {
    await handlers.get(IpcChannels.SaveApiKey)?.({}, "openai", "sk-live");

    // The chat that is already open has to pick the key up, or the model the
    // user just paid for stays unusable until the app restarts.
    expect(refreshAgentProviders).toHaveBeenCalled();
  });

  it("does the same for a key pasted into the keys panel", async () => {
    await handlers.get(IpcChannels.SaveApiKey)?.({}, "abacus", "s2_pasted");

    expect(ensureMcpServer).toHaveBeenCalledTimes(1);
    expect(ensureMcpServer.mock.calls[0]?.[0]).toMatchObject(gateway);
    expect(profileKeyFor).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ada@example.com" })
    );
    expect(activateProfile).toHaveBeenCalledWith("acct-test", "s2_pasted", [
      "ada@example.com_acme",
    ]);
  });

  it("takes the gateway away when the key is removed", async () => {
    // The bug: the entry was added here but removed only by the Settings
    // sign-out, so a key that ended any other way left a server behind that
    // the app could never authenticate: listed in MCP, serving nothing, for
    // a user the app agreed was signed out.
    await handlers.get(IpcChannels.SaveApiKey)?.({}, "abacus", "");

    expect(ensureMcpServer).not.toHaveBeenCalled();
    expect(removeMcpServer).toHaveBeenCalledTimes(1);
    expect(removeMcpServer.mock.calls[0]?.[0]).toMatchObject(gateway);
  });

  it("stashes chats when the key is removed through the API-key panel", async () => {
    vi.mocked(readSettings).mockReturnValue({
      apiKeys: { ABACUS_API_KEY: "departing-key" },
    } as never);

    await handlers.get(IpcChannels.SaveApiKey)?.({}, "abacus", "");

    expect(stashSessionsForAccount).toHaveBeenCalledOnce();
    expect(saveApiKey).toHaveBeenCalledWith("abacus", "");
  });

  it("leaves other providers' keys out of it", async () => {
    await handlers.get(IpcChannels.SaveApiKey)?.({}, "groq", "gsk_key");

    expect(ensureMcpServer).not.toHaveBeenCalled();
    expect(removeMcpServer).not.toHaveBeenCalled();
  });
});

/**
 * A key the platform has revoked.
 *
 * Every "is this user signed in" check reads the stored key, so a dead one
 * leaves the app in two minds: the account panel says signed out because the
 * fetch 403s, while the menu offers to end a session that is already over and
 * the connector gateway sits in the MCP list unable to authenticate.
 */
describe("asking who the key belongs to", () => {
  const gateway = { mode: "code", name: ABACUS_CONNECTORS_SERVER_NAME };

  it("ends the session when the platform refuses the key", async () => {
    vi.mocked(readSettings).mockReturnValue({
      apiKeys: { ABACUS_API_KEY: "revoked" },
    } as never);
    // The real fetch answers null for a refused key; the rejection flag is
    // what tells this apart from a network failure.
    vi.mocked(fetchAbacusAccount).mockResolvedValue(null);
    vi.mocked(abacusCredentialRejected).mockReturnValue(true);

    await expect(
      handlers.get(IpcChannels.GetAbacusAccount)?.({}, true)
    ).resolves.toBeNull();

    expect(vi.mocked(saveApiKey)).toHaveBeenCalledWith("abacus", "");
    expect(removeMcpServer.mock.calls[0]?.[0]).toMatchObject(gateway);
  });

  it("keeps the session when the request merely failed", async () => {
    // A timeout or a 500 says nothing about the key, and signing someone out
    // over a dropped connection is worse than showing a stale profile.
    vi.mocked(readSettings).mockReturnValue({
      apiKeys: { ABACUS_API_KEY: "good" },
    } as never);
    vi.mocked(abacusCredentialRejected).mockReturnValue(false);

    await handlers.get(IpcChannels.GetAbacusAccount)?.({}, true);

    expect(vi.mocked(saveApiKey)).not.toHaveBeenCalled();
    expect(removeMcpServer).not.toHaveBeenCalled();
  });

  it("does nothing when the fetch succeeded", async () => {
    vi.mocked(fetchAbacusAccount).mockResolvedValue({ name: "Ada" } as never);
    vi.mocked(abacusCredentialRejected).mockReturnValue(true);

    await expect(
      handlers.get(IpcChannels.GetAbacusAccount)?.({}, true)
    ).resolves.toMatchObject({ name: "Ada" });

    expect(vi.mocked(saveApiKey)).not.toHaveBeenCalled();
  });

  it("has nothing to clear when no key is stored", async () => {
    vi.mocked(abacusCredentialRejected).mockReturnValue(true);

    await handlers.get(IpcChannels.GetAbacusAccount)?.({}, true);

    expect(vi.mocked(saveApiKey)).not.toHaveBeenCalled();
    expect(removeMcpServer).not.toHaveBeenCalled();
  });
});

/**
 * A key nobody can attribute to an account.
 *
 * The profile a run uses is chosen by account key, so an unattributable key
 * has no home of its own. Letting it through would drop that account into
 * whichever profile is already active, handing it someone else's sessions,
 * workspaces and memories, and writing its key into their config. Two ways in:
 * the /v1/account read fails every retry, or a deployment without that
 * endpoint answers with a profile carrying no email. The second would put
 * every account on that deployment in one folder, silently and permanently.
 */
describe("signing in with a key that cannot be attributed", () => {
  beforeEach(() => {
    vi.mocked(fetchAbacusAccount).mockResolvedValue({
      email: null,
    } as never);
    vi.mocked(profileKeyFor).mockReturnValue(null);
  });

  it("refuses, rather than borrowing whichever profile is open", async () => {
    const result = await handlers.get(IpcChannels.StartAbacusAuth)?.({});

    expect(result).toMatchObject({ ok: false, error: "unidentified-account" });
  });

  it("puts the key back where it found it: nowhere", async () => {
    await handlers.get(IpcChannels.StartAbacusAuth)?.({});

    // Stored on the way in (the sign-in stores before it identifies), so
    // refusing has to undo that or the wall would let the user straight past.
    expect(vi.mocked(saveApiKey)).toHaveBeenCalledWith("abacus", "");
  });

  it("restores the previous account when a replacement key cannot be identified", async () => {
    vi.mocked(readSettings).mockReturnValue({
      apiKeys: { ABACUS_API_KEY: "previous-key" },
    } as never);

    const save = handlers.get(IpcChannels.SaveApiKey);
    if (save == null)
      throw new Error("save API key handler was not registered");
    await (save({}, "abacus", "unidentified-key") as Promise<unknown>).catch(
      () => undefined
    );

    expect(vi.mocked(saveApiKey).mock.calls.at(-1)).toEqual([
      "abacus",
      "previous-key",
    ]);
  });

  it("still signs in when the account can be identified", async () => {
    vi.mocked(profileKeyFor).mockReturnValue("ada@example.com_acme");

    const result = await handlers.get(IpcChannels.StartAbacusAuth)?.({});

    expect(result).toMatchObject({ ok: true });
  });
});

describe("legacy bot IPC", () => {
  it.each([undefined, null, "none", "glasses"])(
    "forwards create and update with accessory %s",
    (avatarAccessory) => {
      const look = avatarAccessory === undefined ? {} : { avatarAccessory };
      const input = { name: "Ada", description: "Counts", ...look };
      const created = { id: "bot-ada", ...input };
      createBot.mockReturnValue(created);
      expect(handlers.get(IpcChannels.CreateBot)!(null, input)).toBe(created);
      expect(createBot).toHaveBeenCalledWith(input);
      const changes = { title: "Counter", ...look };
      const updated = { ...created, ...changes };
      updateBot.mockReturnValue(updated);
      expect(
        handlers.get(IpcChannels.UpdateBot)!(null, created.id, changes)
      ).toBe(updated);
      expect(updateBot).toHaveBeenCalledWith(created.id, changes);
      if (avatarAccessory === undefined) {
        expect(createBot.mock.calls[0][0]).not.toHaveProperty(
          "avatarAccessory"
        );
        expect(updateBot.mock.calls[0][1]).not.toHaveProperty(
          "avatarAccessory"
        );
      }
    }
  );
});
