/**
 * `connect_connector`: what the agent can see and how it asks.
 *
 * The failure this replaces is an agent reporting "I cannot do that, Slack is
 * not connected" and stopping: a dead end for something the user could fix
 * with one click. So the listing is the whole registry, connected or not (an
 * agent that only sees what it has cannot name what it needs), and asking
 * suspends the turn behind a Connect button rather than ending it. Every
 * connector in the registry is available to every chat, whatever its kind:
 * a platform account, a chat app, a token card. The button is the gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorStatuses } from "#shared/contracts";
import { sessionConversationKey } from "#shared/conversation-scope";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

/** The statuses main would answer with, per test. */
let statuses: ConnectorStatuses;

const request = vi.fn(async () => "Slack is connected now. Carry on.");

const server = (): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["connectors"]),
    workspacePath: () => null,
    conversationKeyForSession: (sessionId) =>
      sessionId === "nowhere"
        ? null
        : sessionConversationKey("ws-1", sessionId),
    connectors: {
      list: async () => statuses,
      request,
    },
    messaging: {
      runningPlatforms: () => [] as never,
      livePlatforms: () => [] as never,
      listChats: () => [],
      send: async () => undefined as never,
      readMessages: async () => [] as never,
    } as never,
  });

const call = async (
  args: Record<string, unknown>,
  session = "session-1"
): Promise<string> => {
  const result = await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("connect_connector", args, session);

  return result.content.map((part) => part.text ?? "").join("\n");
};

beforeEach(() => {
  vi.clearAllMocks();
  statuses = {
    "abacus-gmailuser": {
      state: "connected",
      account: "Gmail - ada@example.com",
    },
    "abacus-slack": { state: "available" },
    "abacus-googlecalendar": { state: "available" },
    "abacus-googledriveuser": { state: "available" },
    github: { state: "available" },
    "messaging-whatsapp": { state: "available" },
    "messaging-telegram": { state: "available" },
    "messaging-discord": { state: "available" },
  };
});

describe("listing what exists", () => {
  it("names the ones that are not connected, not just the ones that are", async () => {
    const text = await call({});

    expect(text).toContain("abacus-slack");
    expect(text).toContain("not connected");
    expect(text).toContain("abacus-gmailuser");
    expect(text).toContain("connected");
    // The whole registry, every chat: no grant filters this list any more.
    expect(text).toContain("abacus-googlecalendar");
    expect(text).toContain("github");
  });

  /**
   * Who the connected one is connected as. Without it the agent knows Gmail
   * works but not whose Gmail it is, and an "email myself" turns into a
   * question the user already answered by connecting.
   */
  it("names the account behind each connected one", async () => {
    const text = await call({});

    expect(text).toContain("connected as Gmail - ada@example.com");
    // Nothing invented for the ones that are not attached.
    expect(text).toContain("abacus-slack  Slack  not connected");
  });
});

describe("asking for one", () => {
  it("puts it in front of the user and waits", async () => {
    const text = await call({ service: "slack", reason: "to read #general" });

    // The caller's session rides along so the Connect button lands in the chat
    // that asked and not in whichever one the user happens to be reading.
    expect(request).toHaveBeenCalledWith({
      connectorId: "abacus-slack",
      label: "Slack",
      reason: "to read #general",
      conversationKey: sessionConversationKey("ws-1", "session-1"),
    });
    expect(text).toContain("connected now");
  });

  it("refuses a caller with no conversation to ask in", async () => {
    const text = await call({ service: "slack" }, "nowhere");

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("no conversation to ask in");
  });

  it("does not ask for something already connected", async () => {
    const text = await call({ service: "gmailuser" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("already connected as Gmail - ada@example.com");
    // And no guessed tool names on the way out of it.
    expect(text).toContain("already in your tool list");
  });

  it("asks for GitHub with the same button as everything else: the card takes a token", async () => {
    for (const service of ["github", "GitHub"]) {
      vi.clearAllMocks();

      const text = await call({ service, reason: "to open a pull request" });

      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: "github", label: "GitHub" })
      );
      expect(text).toContain("connected now");
    }
  });

  it("asks for a tool server with the same button (Playwright is a connector here)", async () => {
    // The regression: "connect playwright" was answered with "Playwright
    // isn't a connector" and an npm install recipe. It is in the registry, so
    // it gets the button, and connecting installs it.
    const text = await call({ service: "playwright" });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: "playwright",
        label: "Playwright",
      })
    );
    expect(text).toContain("connected now");
  });

  it("tells the model what a token unlocks, since no tools arrive with it", async () => {
    await call({ service: "github" });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedHint: "Use `gh` and git in bash: they are authenticated now.",
      })
    );
  });

  it("tells the model gh is authenticated once the token is stored", async () => {
    statuses.github = { state: "connected" };

    const text = await call({ service: "github" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("`gh` and git in bash");
  });

  it("says so when the service does not exist at all", async () => {
    const text = await call({ service: "myspace" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain('no connector called "myspace"');
    // The list it offers pairs name with id, so either token works next time.
    expect(text).toContain("Gmail (abacus-gmailuser)");
  });

  it("resolves a display name to its id", async () => {
    // The observed failure: the id is "abacus-gmailuser", the model asks for
    // "gmail" (Gmail is connected here, so the answer is already-connected;
    // the point is that the name resolved at all).
    const text = await call({ service: "gmail" });

    expect(text).toContain("Gmail is already connected");
  });

  it("shrugs off case, spaces and punctuation in the ask", async () => {
    const text = await call({ service: "Google Drive" });

    expect(request).toHaveBeenCalledWith({
      connectorId: "abacus-googledriveuser",
      label: "Google Drive",
      conversationKey: sessionConversationKey("ws-1", "session-1"),
    });
    expect(text).toContain("connected now");
  });

  it("names the candidates instead of guessing when an ask is ambiguous", async () => {
    const text = await call({ service: "google" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("more than one connector");
    expect(text).toContain("Google Calendar");
    expect(text).toContain("Google Drive");
  });

  it("does not put a button up for a service the account cannot offer", async () => {
    statuses["abacus-slack"] = { state: "unavailable", reason: "not-offered" };

    const text = await call({ service: "slack" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("does not offer it");
  });

  it("says the app is signed out rather than pretending to connect", async () => {
    statuses["abacus-slack"] = {
      state: "unavailable",
      reason: "not-signed-in",
    };

    const text = await call({ service: "slack" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("not signed in to Abacus.AI");
  });
});

/**
 * The chat apps are connectors too, in the same registry: leaving them out
 * let the agent tell a user that WhatsApp "isn't available as a connector on
 * this system", inside the app whose WhatsApp bot they were talking to.
 */
describe("the chat apps", () => {
  it("are listed alongside the account's connectors", async () => {
    const text = await call({});

    expect(text).toContain("messaging-whatsapp");
    expect(text).toContain("messaging-telegram");
    expect(text).toContain("messaging-discord");
    expect(text).toContain("abacus-gmailuser");
  });

  it("show as connected when the gateway has one live", async () => {
    statuses["messaging-whatsapp"] = { state: "connected" };

    const text = await call({});

    expect(text).toMatch(/messaging-whatsapp\s+WhatsApp\s+connected/);
  });

  it("put a Connect button in front of the user, like any other connector", async () => {
    const text = await call({ service: "whatsapp" });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: "messaging-whatsapp",
        label: "WhatsApp",
      })
    );
    expect(text).not.toMatch(/no connector called/i);
  });

  it("tell the agent to just send when the platform is already linked", async () => {
    statuses["messaging-whatsapp"] = { state: "connected" };

    const text = await call({ service: "whatsapp" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("send_<platform>_message");
  });

  it("still put the button up for a started platform that is not linked", async () => {
    // The phone-side unlink: the connector object survives, waiting on a QR.
    // "Running" once counted as connected here, and the one tool whose job is
    // the Connect button answered that there was nothing to connect.
    statuses["messaging-whatsapp"] = { state: "pending", reason: "not-live" };

    const text = await call({ service: "whatsapp" });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: "messaging-whatsapp" })
    );
    expect(text).not.toMatch(/messaging-whatsapp\s+WhatsApp\s+connected/);
  });
});

/**
 * `disconnect_connector`: the other half of the round trip. Until it existed
 * the agent answered "I don't have a tool that disconnects" and sent the user
 * to Settings, for a detach the platform API supports in one call.
 */
describe("disconnecting", () => {
  const disconnected: string[] = [];
  const disabled: string[] = [];

  const disconnectServer = (): McpAgentToolsServer =>
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["connectors"]),
      workspacePath: () => null,
      connectors: {
        list: async () => statuses,
        request,
        disconnect: async (connectorId: string) => {
          disconnected.push(connectorId);
          return null;
        },
      },
      messaging: {
        runningPlatforms: () => ["whatsapp"] as never,
        livePlatforms: () => ["whatsapp"] as never,
        disablePlatform: async (id: string) => {
          disabled.push(id);
        },
        listChats: () => [],
        send: async () => undefined as never,
        readMessages: async () => [] as never,
      } as never,
    });

  const disconnect = async (service: string): Promise<string> => {
    const result = await (
      disconnectServer() as unknown as {
        executeTool: (
          name: string,
          args: Record<string, unknown>,
          session?: string
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool("disconnect_connector", { service }, "session-1");

    return result.content.map((part) => part.text ?? "").join("\n");
  };

  beforeEach(() => {
    disconnected.length = 0;
    disabled.length = 0;
  });

  it("detaches an attached account connector by its id", async () => {
    const text = await disconnect("gmail");

    expect(disconnected).toEqual(["abacus-gmailuser"]);
    expect(text).toContain("Gmail is disconnected");
  });

  it("says so for a service that is simply not connected", async () => {
    const text = await disconnect("slack");

    expect(disconnected).toEqual([]);
    expect(text).toContain("not connected: nothing to disconnect");
  });

  it("switches a chat app off through the gateway, the same lever as its card", async () => {
    const text = await disconnect("whatsapp");

    expect(disabled).toEqual(["whatsapp"]);
    expect(disconnected).toEqual([]);
    expect(text).toContain("WhatsApp is disconnected");
  });

  it("clears a stored token the same way", async () => {
    statuses.github = { state: "connected" };

    const text = await disconnect("github");

    expect(disconnected).toEqual(["github"]);
    expect(text).toContain("GitHub is disconnected");
  });

  it("refuses a name it cannot resolve", async () => {
    const text = await disconnect("myspace");

    expect(disconnected).toEqual([]);
    expect(text).toContain('no connector called "myspace"');
  });
});
