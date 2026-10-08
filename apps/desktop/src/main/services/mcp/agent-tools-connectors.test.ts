import type { ConnectorStatuses } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
/**
 * `connect_connector`: what the agent can see and how it asks.
 *
 * The failure this replaces is an agent reporting "I cannot do that, Slack is
 * not connected" and stopping: a dead end for something the user could fix
 * with one click. So the listing is the whole registry, connected or not (an
 * agent that only sees what it has cannot name what it needs), and asking
 * answers at once with a one-tap link (and a Connect card in the app) rather
 * than ending the turn, or holding it: nothing waits for the user. Every
 * connector in the registry is available to every chat, whatever its kind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

/** The statuses main would answer with, per test. */
let statuses: ConnectorStatuses;

const link = vi.fn(async (connectorId: string) =>
  connectorId === "abacus-googledriveuser"
    ? {
        url: "https://apps.example/chatllm/connect-connector?service=google&r=req&autostart=1",
        connectorIds: [
          "abacus-gmailuser",
          "abacus-googledriveuser",
          "abacus-googlecalendar",
        ],
      }
    : {
        url: `https://apps.example/chatllm/connect-connector?service=${connectorId}&r=req&autostart=1`,
        connectorIds: [connectorId],
      }
);
const show = vi.fn();
const watch = vi.fn();

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
      link,
      show,
      watch,
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
    "abacus-githubbot": { state: "available" },
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
    expect(text).toContain("abacus-githubbot");
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
  it("answers at once with a link, puts a card in the chat that asked, and follows it", async () => {
    const text = await call({ service: "slack", reason: "to read #general" });

    // The caller's session rides along so the card lands in the chat that
    // asked and not in whichever one the user happens to be reading.
    expect(show).toHaveBeenCalledWith({
      connectorId: "abacus-slack",
      label: "Slack",
      reason: "to read #general",
      conversationKey: sessionConversationKey("ws-1", "session-1"),
    });
    expect(watch).toHaveBeenCalledWith({
      connectorIds: ["abacus-slack"],
      sessionId: "session-1",
    });
    expect(text).toContain("service=abacus-slack&r=req");
    expect(text).toContain("This call does not wait");
  });

  it("offers one Google consent for what is still missing, and watches only that", async () => {
    // Gmail is connected here: it is named as such, and never watched, since
    // an already connected member would read as the link landing.
    const text = await call({ service: "Google Drive" });

    expect(text).toContain("Gmail is already connected");
    expect(text).toContain("Google Drive, Google Calendar, all in one step");
    expect(text).toContain("service=google&r=req");
    expect(watch).toHaveBeenCalledWith({
      connectorIds: ["abacus-googledriveuser", "abacus-googlecalendar"],
      sessionId: "session-1",
    });
  });

  it("still gives a caller with no conversation the link, with no card", async () => {
    const text = await call({ service: "slack" }, "nowhere");

    expect(show).not.toHaveBeenCalled();
    expect(text).toContain("service=abacus-slack&r=req");
  });

  it("does not ask for something already connected", async () => {
    const text = await call({ service: "gmailuser" });

    expect(link).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(text).toContain("already connected as Gmail - ada@example.com");
    // And no guessed tool names on the way out of it.
    expect(text).toContain("already in your tool list");
  });

  it("puts a card up, without waiting, for what only the app can connect (a tool server)", async () => {
    for (const service of ["huggingface", "Hugging Face"]) {
      vi.clearAllMocks();
      // The host has no link for a local tool server.
      link.mockResolvedValueOnce(null as never);

      const text = await call({ service });

      expect(link).toHaveBeenCalledWith("huggingface", "session-1");
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationKey: sessionConversationKey("ws-1", "session-1"),
        })
      );
      expect(text).toContain("this call does not wait");
    }
  });

  it("hands out the web host's connect route for an MCP connector, for the model to send", async () => {
    link.mockResolvedValueOnce({
      url: "https://apps.example/api/botHost/h1/mcp/connect/notion",
      connectorIds: ["notion"],
    });

    const text = await call({ service: "Notion" });

    expect(link).toHaveBeenCalledWith("notion", "session-1");
    expect(text).toContain(
      "https://apps.example/api/botHost/h1/mcp/connect/notion"
    );
    expect(watch).toHaveBeenCalledWith(
      expect.objectContaining({ connectorIds: ["notion"] })
    );
  });

  it("never offers a browser to connect: the browser is built in", async () => {
    for (const service of ["playwright", "Playwright"]) {
      vi.clearAllMocks();

      const text = await call({ service });

      expect(show).not.toHaveBeenCalled();
      expect(watch).not.toHaveBeenCalled();
      expect(text).toContain(`There is no connector called "${service}"`);
    }
    expect(await call({})).not.toMatch(/playwright/i);
  });

  it("asks for GitHub with a one-tap link, like any account connector", async () => {
    const text = await call({ service: "GitHub" });

    expect(link).toHaveBeenCalledWith("abacus-githubbot", "session-1");
    expect(text).toContain("service=abacus-githubbot&r=req");
  });

  it("tells the model gh and git are signed in as the user once GitHub is connected", async () => {
    statuses["abacus-githubbot"] = {
      state: "connected",
      account: "GitHub - octocat",
    };

    const text = await call({ service: "github" });

    expect(link).not.toHaveBeenCalled();
    expect(text).toContain("as GitHub - octocat");
    expect(text).toContain("`gh` and git in bash");
  });

  it("says so when the service does not exist at all", async () => {
    const text = await call({ service: "myspace" });

    expect(show).not.toHaveBeenCalled();
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

  it("names the candidates instead of guessing when an ask is ambiguous", async () => {
    const text = await call({ service: "google" });

    expect(show).not.toHaveBeenCalled();
    expect(text).toContain("more than one connector");
    expect(text).toContain("Google Calendar");
    expect(text).toContain("Google Drive");
  });

  it("does not offer a service the account cannot", async () => {
    statuses["abacus-slack"] = { state: "unavailable", reason: "not-offered" };

    const text = await call({ service: "slack" });

    expect(link).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(text).toContain("does not offer it");
  });

  it("says the app is signed out rather than pretending to connect", async () => {
    statuses["abacus-slack"] = {
      state: "unavailable",
      reason: "not-signed-in",
    };

    const text = await call({ service: "slack" });

    expect(show).not.toHaveBeenCalled();
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

  it("put a Connect card in front of the user, like any other connector", async () => {
    const text = await call({ service: "whatsapp" });

    expect(show).toHaveBeenCalledWith(
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

    expect(show).not.toHaveBeenCalled();
    expect(text).toContain("send_<platform>_message");
  });

  it("still put the card up for a started platform that is not linked", async () => {
    // The phone-side unlink: the connector object survives, waiting on a QR.
    statuses["messaging-whatsapp"] = { state: "pending", reason: "not-live" };

    const text = await call({ service: "whatsapp" });

    expect(show).toHaveBeenCalledWith(
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
        link,
        show,
        watch,
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

  it("detaches GitHub like any account connector", async () => {
    statuses["abacus-githubbot"] = { state: "connected" };

    const text = await disconnect("github");

    expect(disconnected).toEqual(["abacus-githubbot"]);
    expect(text).toContain("GitHub is disconnected");
  });

  it("refuses a name it cannot resolve", async () => {
    const text = await disconnect("myspace");

    expect(disconnected).toEqual([]);
    expect(text).toContain('no connector called "myspace"');
  });
});
