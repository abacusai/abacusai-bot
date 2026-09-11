/**
 * `connect_connector`: what the agent can see and how it asks.
 *
 * The failure this replaces is an agent reporting "I cannot do that, Slack is
 * not connected" and stopping — a dead end for something the user could fix
 * with one click. So the catalog includes what is NOT attached (an agent that
 * only sees what it has cannot name what it needs), and asking suspends the
 * turn behind a Connect button rather than ending it. Every connector on the
 * machine is available to every chat; the button is the gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionConversationKey } from "#shared/conversation-scope";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

// Real catalog shape on purpose: service ids are not the display names
// (Gmail's id is "gmailuser"), which is exactly what the matcher must absorb.
const CATALOG = {
  available: [
    { service: "slack", name: "Slack" },
    { service: "gmailuser", name: "Gmail" },
    { service: "googlecalendar", name: "Google Calendar" },
    { service: "googledriveuser", name: "Google Drive" },
  ],
  connected: ["gmailuser"],
  accounts: { gmailuser: "Gmail - ada@example.com" },
};

const request = vi.fn(async () => "Slack is connected now. Carry on.");

/** Which chat apps the gateway reports as live, per test. */
let live: string[] = [];
/** Started connectors — a superset of live: needs_login still counts here. */
let running: string[] | null = null;

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
      list: async () => CATALOG,
      request,
    },
    messaging: {
      runningPlatforms: () => (running ?? live) as never,
      livePlatforms: () => live as never,
      listChats: () => [],
      send: async () => undefined as never,
      readMessages: async () => [] as never,
    } as never,
  });

const call = async (args: Record<string, unknown>): Promise<string> => {
  const result = await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("connect_connector", args, "session-1");

  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("listing what exists", () => {
  it("names the ones that are not connected, not just the ones that are", async () => {
    const text = await call({});

    expect(text).toContain("slack");
    expect(text).toContain("not connected");
    expect(text).toContain("gmailuser");
    expect(text).toContain("connected");
    // The whole catalog, every chat: no grant filters this list any more.
    expect(text).toContain("googlecalendar");
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
    expect(text).toContain("slack  Slack  not connected");
  });
});

describe("asking for one", () => {
  it("puts it in front of the user and waits", async () => {
    vi.clearAllMocks();

    const text = await call({ service: "slack", reason: "to read #general" });

    // The caller's session rides along so the Connect button lands in the chat
    // that asked and not in whichever one the user happens to be reading.
    expect(request).toHaveBeenCalledWith({
      service: "slack",
      label: "Slack",
      reason: "to read #general",
      conversationKey: sessionConversationKey("ws-1", "session-1"),
    });
    expect(text).toContain("connected now");
  });

  it("does not ask for something already connected", async () => {
    vi.clearAllMocks();

    const text = await call({ service: "gmailuser" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("already connected as Gmail - ada@example.com");
    // And no guessed tool names on the way out of it.
    expect(text).toContain("already in your tool list");
  });

  it("says so when the service does not exist at all", async () => {
    vi.clearAllMocks();

    const text = await call({ service: "myspace" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain('no connector called "myspace"');
    // The list it offers pairs name with id, so either token works next time.
    expect(text).toContain("Gmail (gmailuser)");
  });

  it("resolves a display name to its service id", async () => {
    vi.clearAllMocks();

    // The observed failure: the id is "gmailuser", the model asks for
    // "gmail" (Gmail is connected here, so the answer is already-connected —
    // the point is that the name resolved at all).
    const text = await call({ service: "gmail" });

    expect(text).toContain("Gmail is already connected");
  });

  it("shrugs off case, spaces and punctuation in the ask", async () => {
    vi.clearAllMocks();

    const text = await call({ service: "Google Drive" });

    expect(request).toHaveBeenCalledWith({
      service: "googledriveuser",
      label: "Google Drive",
      conversationKey: sessionConversationKey("ws-1", "session-1"),
    });
    expect(text).toContain("connected now");
  });

  it("names the candidates instead of guessing when an ask is ambiguous", async () => {
    vi.clearAllMocks();

    const text = await call({ service: "google" });

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("more than one connector");
    expect(text).toContain("Google Calendar");
    expect(text).toContain("Google Drive");
  });
});

/**
 * The chat apps are connectors too, and they are not in the account catalog:
 * they are set up in this app's own messaging settings. Leaving them out let
 * the agent tell a user that WhatsApp "isn't available as a connector on this
 * system" — inside the app whose WhatsApp bot they were talking to.
 */
describe("the chat apps", () => {
  beforeEach(() => {
    live = [];
    running = null;
  });

  it("are listed alongside the account's connectors", async () => {
    const text = await call({});

    expect(text).toContain("whatsapp");
    expect(text).toContain("telegram");
    expect(text).toContain("discord");
    // And the catalog's own are still there.
    expect(text).toContain("gmailuser");
  });

  it("show as connected when the gateway is running one", async () => {
    live = ["whatsapp"];

    const text = await call({});

    expect(text).toMatch(/whatsapp\s+WhatsApp\s+connected/);
  });

  it("put a Connect button in front of the user, like any other connector", async () => {
    const text = await call({ service: "whatsapp" });

    // Not a paragraph telling them where the settings are: the same round trip
    // Gmail gets, because the thing they need is one click.
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ service: "whatsapp", label: "WhatsApp" })
    );
    expect(text).not.toMatch(/no connector called/i);
  });

  it("tell the agent to just send when the platform is already linked", async () => {
    live = ["whatsapp"];

    const text = await call({ service: "whatsapp" });

    expect(text).toContain("send_<platform>_message");
  });

  it("still put the button up for a started platform that is not linked", async () => {
    // The phone-side unlink: the connector object survives, waiting on a QR.
    // "Running" once counted as connected here, and the one tool whose job is
    // the Connect button answered that there was nothing to connect.
    running = ["whatsapp"];
    live = [];

    await call({ service: "whatsapp" });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ service: "whatsapp", label: "WhatsApp" })
    );
  });

  it("list a started-but-unlinked platform as not connected", async () => {
    running = ["whatsapp"];
    live = [];

    const text = await call({});

    expect(text).not.toMatch(/whatsapp\s+WhatsApp\s+connected/);
  });
});

/**
 * `disconnect_connector`: the other half of the round trip. Until it existed
 * the agent answered "I don't have a tool that disconnects" and sent the user
 * to Settings — for a detach the platform API supports in one call.
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
        list: async () => CATALOG,
        request,
        disconnect: async (service: string) => {
          disconnected.push(service);
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

  it("detaches a connected account connector", async () => {
    const text = await disconnect("gmailuser");

    expect(disconnected).toEqual(["gmailuser"]);
    expect(text).toContain("disconnected");
  });

  it("switches a chat app off instead of calling the account platform", async () => {
    const text = await disconnect("whatsapp");

    expect(disabled).toEqual(["whatsapp"]);
    expect(disconnected).toEqual([]);
    expect(text).toContain("switched off");
  });

  it("says so for a service that is not connected", async () => {
    const text = await disconnect("slack");

    expect(disconnected).toEqual([]);
    expect(text).toContain("not connected");
  });

  it("refuses a name that matches nothing", async () => {
    const text = await disconnect("carrier-pigeon");

    expect(text).toContain("no connector called");
  });

  it("shows no button, and says so, for a caller with no conversation", async () => {
    vi.clearAllMocks();
    // "Wherever the user is" was how a bot's ask landed in a stranger's chat.
    const text = await (
      server() as unknown as {
        executeTool: (
          name: string,
          args: Record<string, unknown>,
          session?: string
        ) => Promise<{ content: { text?: string }[] }>;
      }
    )
      .executeTool("connect_connector", { service: "slack" }, "nowhere")
      .then((result) => result.content.map((part) => part.text ?? "").join(""));

    expect(request).not.toHaveBeenCalled();
    expect(text).toContain("no conversation to ask in");
  });
});
