/**
 * One tool per platform, nothing shared.
 *
 * The rule after a Discord DM vanished behind a WhatsApp address
 * book: a platform's contacts, messages and senders never appear beside
 * another platform's. Each platform has its own send, read, list and
 * auto-reply tool; the cross-platform originals are hidden from the model.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

type Sent = { platform: string; chatId: string; text: string };

const harness = (running: string[]) => {
  const sent: Sent[] = [];
  const reads: Array<Record<string, unknown>> = [];
  const allowed: Array<{ platform: string; name: string }> = [];
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    botIdForSession: () => "bot-1",
    messaging: {
      runningPlatforms: () => running,
      livePlatforms: () => running,
      listChats: () => [],
      send: async (platform: string, chatId: string, text: string) => {
        sent.push({ platform, chatId, text });
      },
      readMessages: async (filter: Record<string, unknown>) => {
        reads.push(filter);
        return [];
      },
      autoReply: {
        status: () => ({
          enabled: false,
          botId: null,
          approved: [],
          pending: [],
        }),
        enable: () => {},
        disable: () => {},
        senderCandidates: (platform: string) => [
          { platform, userId: "u1", chatId: "u1", name: "Anuja" },
        ],
        allowSender: (candidate: { platform: string; name: string }) => {
          allowed.push({ platform: candidate.platform, name: candidate.name });
        },
        removeSender: () => {},
      },
    },
  } as never);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await (
      server as unknown as {
        executeTool: (
          n: string,
          a: Record<string, unknown>,
          s?: string
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool(name, args, "bot-session");
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  return { server, sent, reads, allowed, call };
};

describe("the model's messaging tools", () => {
  it("are per platform; the cross-platform originals are not listed", () => {
    const { server } = harness(["whatsapp", "discord"]);
    const listed = server.listedToolNames(true);

    for (const shared of [
      "send_chat_message",
      "read_chat_messages",
      "list_chats",
      "auto_reply",
    ])
      expect(listed).not.toContain(shared);

    for (const own of [
      "list_whatsapp_chats",
      "send_whatsapp_message",
      "read_whatsapp_messages",
      "whatsapp_auto_reply",
      "list_discord_chats",
      "send_discord_message",
      "read_discord_messages",
      "discord_auto_reply",
    ])
      expect(listed).toContain(own);
  });

  it("exist only for platforms that are running", () => {
    const { server } = harness(["whatsapp"]);
    const listed = server.listedToolNames(true);
    expect(listed).toContain("send_whatsapp_message");
    expect(listed).not.toContain("send_discord_message");
    expect(listed).not.toContain("list_telegram_chats");
  });

  it("send goes to its own platform, whatever the args say", async () => {
    const { sent, call } = harness(["whatsapp", "discord"]);
    await call("send_discord_message", { to: "123/456", message: "hi" });
    expect(sent).toEqual([
      { platform: "discord", chatId: "123/456", text: "hi" },
    ]);
  });

  it("read is scoped to its own platform", async () => {
    const { reads, call } = harness(["whatsapp", "discord"]);
    await call("read_whatsapp_messages", { chat_id: "Ma", limit: 5 });
    expect(reads).toEqual([{ platform: "whatsapp", chatId: "Ma", limit: 5 }]);
  });

  it("auto-reply allows the sender on its own platform, no platform question", async () => {
    const { allowed, call } = harness(["whatsapp", "discord"]);
    const text = await call("discord_auto_reply", {
      action: "allow_sender",
      sender: "Anuja",
    });
    expect(allowed).toEqual([{ platform: "discord", name: "Anuja" }]);
    expect(text).not.toMatch(/say which one/);
  });
});

describe("a routine run's messages to someone", () => {
  /** Sessions `run-a` and `run-b` answer the same fire; `chat` answers none. */
  const routineHarness = () => {
    const sent: Sent[] = [];
    const server = new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["messaging"]),
      workspacePath: () => null,
      botIdForSession: () => null,
      routineFireForSession: (sessionId: string) =>
        sessionId === "chat" ? null : "job-1@1700000000000",
      messaging: {
        runningPlatforms: () => ["whatsapp"],
        livePlatforms: () => ["whatsapp"],
        listChats: () => [],
        send: async (platform: string, chatId: string, text: string) => {
          sent.push({ platform, chatId, text });
        },
      },
    } as never);
    const send = async (session: string, to: string, message: string) => {
      const result = await (
        server as unknown as {
          executeTool: (
            n: string,
            a: Record<string, unknown>,
            s?: string
          ) => Promise<{ content: { text?: string }[] }>;
        }
      ).executeTool("send_whatsapp_message", { to, message }, session);
      return result.content.map((part) => part.text ?? "").join("\n");
    };
    return { sent, send };
  };

  it("reach each person once per scheduled moment, whichever run sends", async () => {
    const { sent, send } = routineHarness();

    expect(await send("run-a", "Sam", "Good morning")).toContain("Sent");
    const second = await send("run-b", "sam ", "Good morning, again");

    // Skipped and said so, not an error: Sam already has this moment's message.
    expect(second).toContain("Skipped");
    expect(second).toContain("already got a message");
    expect(sent).toHaveLength(1);
  });

  it("skip the same text twice from one run, but let it go on in parts", async () => {
    const { sent, send } = routineHarness();

    await send("run-a", "Sam", "Part one");
    expect(await send("run-a", "Sam", "Part two")).toContain("Sent");
    expect(await send("run-a", "Sam", "Part one")).toContain("Skipped");
    expect(await send("run-a", "Alex", "Part one")).toContain("Sent");
    expect(sent.map((entry) => entry.text)).toEqual([
      "Part one",
      "Part two",
      "Part one",
    ]);
  });

  it("leave a conversation's own sends alone", async () => {
    const { sent, send } = routineHarness();

    await send("chat", "Sam", "Hi");
    await send("chat", "Sam", "Hi");

    expect(sent).toHaveLength(2);
  });
});

describe("a routine run whose answer the app delivers to the user's own chat", () => {
  // A made-up number, built from parts so no scanner takes it for a real one.
  const PARTS = ["1", "555", "000", "1111"];
  const SELF = `${PARTS.join("")}@c.us`;
  const deliveringHarness = () => {
    const sent: Sent[] = [];
    const files: string[] = [];
    const server = new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["messaging"]),
      workspacePath: () => null,
      botIdForSession: () => null,
      routineFireForSession: () => "job-1@1700000000000",
      routineDeliversToSelf: (_session: string, platform: string) =>
        platform === "whatsapp",
      messaging: {
        runningPlatforms: () => ["whatsapp"],
        livePlatforms: () => ["whatsapp"],
        listChats: () => [],
        selfChats: () => [{ platform: "whatsapp", chatId: SELF }],
        send: async (platform: string, chatId: string, text: string) => {
          sent.push({ platform, chatId, text });
        },
        sendFile: async (_platform: string, _to: string, file: string) => {
          files.push(file);
        },
      },
    } as never);
    const send = async (args: Record<string, unknown>) => {
      const result = await (
        server as unknown as {
          executeTool: (
            n: string,
            a: Record<string, unknown>,
            s?: string
          ) => Promise<{ content: { text?: string }[] }>;
        }
      ).executeTool("send_whatsapp_message", args, "run-a");
      return result.content.map((part) => part.text ?? "").join("\n");
    };
    return { sent, files, send };
  };

  it("skips a text to the user, by name, chat id or own number, and says the app delivers it", async () => {
    const { sent, send } = deliveringHarness();
    for (const to of ["me", SELF, `+${PARTS.join(" ")}`])
      expect(await send({ to, message: "Your digest" })).toContain(
        "the app delivers your final answer"
      );
    expect(sent).toEqual([]);
  });

  it("still sends a text to someone else, and a file to the user", async () => {
    const { sent, files, send } = deliveringHarness();
    expect(await send({ to: "Sam", message: "Hello" })).toContain("Sent");
    const dir = mkdtempSync(join(tmpdir(), "send-file-"));
    const file = join(dir, "report.pdf");
    writeFileSync(file, "pdf");
    expect(
      await send({ to: "me", message: "", attachment_path: file })
    ).toContain("Sent the file");
    expect(sent.map((entry) => entry.chatId)).toEqual(["Sam"]);
    expect(files).toEqual([file]);
  });
});
