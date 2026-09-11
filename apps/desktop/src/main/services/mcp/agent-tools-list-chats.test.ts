/**
 * What `list_chats` says when it has nothing to show.
 *
 * The answer matters more than it looks. A model asked to check Telegram on an
 * empty address book ran nineteen searches in a row — "telegram", "alex",
 * "a", "e", "i", "o", "mom", "What is this" — because every one of them came
 * back as `No contact matching "x"`, which reads as "your query missed" and
 * invites the next guess. Nothing in the reply said the book was empty, so
 * nothing told it to stop.
 */
import { describe, expect, it, vi } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

type Row = {
  platform: "telegram";
  chatId: string;
  name: string;
  status: "approved";
};

const serverWith = (rows: Row[]): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["messaging"]),
    workspacePath: () => null,
    messaging: {
      runningPlatforms: () => ["telegram"],
      listChats: (query?: string) =>
        query == null
          ? rows
          : rows.filter((row) =>
              row.name.toLowerCase().includes(query.toLowerCase())
            ),
    } as never,
  });

/** The tool entry point, which is private because nothing else calls it. */
const listChats = async (
  server: McpAgentToolsServer,
  args: Record<string, unknown>
): Promise<string> => {
  const result = await (
    server as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("list_chats", args);

  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("list_chats with nothing to list", () => {
  it("says the book is empty rather than blaming the query", async () => {
    const text = await listChats(serverWith([]), { query: "mom" });

    expect(text).toContain("No chats yet");
    // The sentence that ends the search.
    expect(text).toContain("Another query will not find anything");
    expect(text).not.toContain('No contact matching "mom"');
  });

  it("says the same thing whether or not a query was passed", async () => {
    const server = serverWith([]);

    expect(await listChats(server, {})).toContain("No chats yet");
    expect(await listChats(server, { query: "a" })).toContain("No chats yet");
  });

  it("counts what it does know when a query genuinely misses", async () => {
    const text = await listChats(
      serverWith([
        {
          platform: "telegram",
          chatId: "1",
          name: "Priya",
          status: "approved",
        },
      ]),
      { query: "mom" }
    );

    // A miss against a book that has entries is a different answer, and the
    // way out of it is naming the way to see them.
    expect(text).toContain('No contact matching "mom", out of 1 known');
    expect(text).toContain("Omit the query");
  });

  it("still lists what it has", async () => {
    const text = await listChats(
      serverWith([
        {
          platform: "telegram",
          chatId: "42",
          name: "Priya",
          status: "approved",
        },
      ]),
      {}
    );

    expect(text).toContain('telegram  to: "42"  (Priya)');
    // The exact `to` is stated, not implied: a WhatsApp group whose chat id
    // IS its display name printed as the name twice, and a model read that
    // as "no usable id" and refused a send that would have worked.
    expect(text).toContain("the exact value for the platform's send");
  });
});

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));
