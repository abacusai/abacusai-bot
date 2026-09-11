/**
 * What `list_chats` tells the agent about who the user is, and about a
 * platform that is connected but not reachable.
 *
 * Both come from one report. A phone unlinked the device mid-conversation:
 * the connector stayed registered and restarted for a fresh QR, its address
 * book went empty with it, and the tool answered "no address book has synced".
 * The agent read that as "you have no contacts" and started asking the user
 * for phone numbers — including, for a message to themselves, their own.
 */
import { describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

type Chat = {
  platform: "whatsapp";
  chatId: string;
  name: string;
  status: "approved";
};

const CONTACT: Chat = {
  platform: "whatsapp",
  chatId: "919999999999@s.whatsapp.net",
  name: "Nisha",
  status: "approved",
};

const server = (options: {
  chats: Chat[];
  live?: boolean;
  self?: boolean;
  starting?: boolean;
  hidden?: Record<string, number>;
}): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    messaging: {
      runningPlatforms: () => ["whatsapp"],
      livePlatforms: () => (options.live === false ? [] : ["whatsapp"]),
      selfChats: () =>
        options.self === false
          ? []
          : [{ platform: "whatsapp", chatId: "919804585173@s.whatsapp.net" }],
      startingPlatforms: () => (options.starting === true ? ["whatsapp"] : []),
      awaitReady: async () => {},
      listChats: (query?: string, platform?: string) =>
        options.chats.filter(
          (row) =>
            (query == null ||
              row.name.toLowerCase().includes(query.toLowerCase())) &&
            (platform == null || row.platform === platform)
        ),
      listChatsDetailed: (query?: string, platform?: string) => ({
        rows: options.chats.filter(
          (row) =>
            (query == null ||
              row.name.toLowerCase().includes(query.toLowerCase())) &&
            (platform == null || row.platform === platform)
        ),
        hidden: options.hidden ?? {},
      }),
      send: async () => {},
      readMessages: async () => [],
    },
  } as never);

const call = async (
  instance: McpAgentToolsServer,
  args: Record<string, unknown>
): Promise<string> => {
  const result = await (
    instance as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("list_chats", args);

  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("who the user is", () => {
  it("names the user's own account, so it is never asked for", async () => {
    const text = await call(server({ chats: [CONTACT] }), {});

    expect(text).toContain("919804585173@s.whatsapp.net");
    expect(text).toContain('(the user — "me")');
  });

  it("names it even when there is nothing else to list", async () => {
    const text = await call(server({ chats: [] }), {});

    expect(text).toContain('(the user — "me")');
  });

  it("says nothing about it before the platform has said who it is", async () => {
    const text = await call(server({ chats: [CONTACT], self: false }), {});

    expect(text).not.toContain('(the user — "me")');
  });
});

describe("a platform that is connected but not reachable", () => {
  /**
   * The empty list is the same either way; only the reason differs, and the
   * reason is the whole difference between "you have no contacts" and "your
   * WhatsApp is not linked right now".
   */
  it("says so rather than letting an empty book read as no contacts", async () => {
    const text = await call(server({ chats: [], live: false }), {});

    expect(text).toContain("Not connected right now: whatsapp");
    expect(text).toContain("rather than");
  });

  it("says so on a search that missed, too", async () => {
    const text = await call(server({ chats: [CONTACT], live: false }), {
      query: "nobody",
    });

    expect(text).toContain("Not connected right now: whatsapp");
  });

  it("never calls a platform connected in the header while it is down", async () => {
    const text = await call(server({ chats: [], live: false }), {});

    expect(text).toContain("Connected platforms: none");
    expect(text).not.toMatch(/Connected platforms: .*whatsapp/u);
  });

  it("stays quiet while everything is up", async () => {
    const text = await call(server({ chats: [CONTACT] }), {});

    expect(text).not.toContain("Not connected right now");
    expect(text).toContain("Nisha");
  });
});

describe("a platform that is still starting", () => {
  /**
   * A new bot's first mission fires seconds after launch, and WhatsApp Web
   * takes most of a minute to boot. In that window the address book is
   * empty and "me" unknown — true, and the wrong answer. The model was told
   * nothing had synced and asked the user to message it first.
   */
  it("says so, and never that nothing has synced", async () => {
    const text = await call(
      server({ chats: [], self: false, starting: true }),
      { query: "me" }
    );
    expect(text).toMatch(/Still starting: whatsapp/);
    expect(text).toMatch(/Try again in about twenty seconds/);
    expect(text).not.toMatch(/no address book has synced/);
    expect(text).not.toMatch(/user has to be messaged first/);
  });
});

describe("a big address book beside a small platform", () => {
  it("says how many rows the cap hid, per platform, and how to see them", async () => {
    const text = await call(
      server({ chats: [CONTACT], hidden: { whatsapp: 240 } }),
      {}
    );
    expect(text).toMatch(/Not shown: 240 more on whatsapp/);
    expect(text).toMatch(/platform: "<name>"/);
  });

  it("scopes to one platform when asked", async () => {
    const discord = {
      platform: "discord" as const,
      chatId: "1234567890",
      name: "anewja",
      status: "approved" as const,
    };
    const text = await call(server({ chats: [CONTACT, discord as never] }), {
      platform: "discord",
    });
    expect(text).toContain("anewja");
    expect(text).not.toContain("Nisha");
  });
});

describe("one tool per platform", () => {
  const callNamed = async (
    instance: McpAgentToolsServer,
    name: string,
    args: Record<string, unknown>
  ): Promise<string> => {
    const result = await (
      instance as unknown as {
        executeTool: (
          name: string,
          args: Record<string, unknown>
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool(name, args);
    return result.content.map((part) => part.text ?? "").join("\n");
  };

  it("lists only that platform, so another's address book cannot crowd it", async () => {
    const discord = {
      platform: "discord" as const,
      chatId: "1234567890",
      name: "anewja",
      status: "approved" as const,
    };
    const instance = server({ chats: [CONTACT, discord as never] });

    const text = await callNamed(instance, "list_discord_chats", {});
    expect(text).toContain("anewja");
    expect(text).not.toContain("Nisha");

    const whatsapp = await callNamed(instance, "list_whatsapp_chats", {});
    expect(whatsapp).toContain("Nisha");
    expect(whatsapp).not.toContain("anewja");
  });
});
