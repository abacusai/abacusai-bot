/**
 * `present_deliverable`: what actually reaches the preview pane.
 *
 * The tool takes a list; every item becomes a row of the chat's files card,
 * and only the first — the primary — goes to the preview pane. A bot's turn
 * sends nothing to the pane at all. Opening the pane is a notification rather
 * than a call, so what is asserted here is the broadcast.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionConversationKey } from "#shared/conversation-scope";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

const sent = vi.fn();

vi.mock("#main/renderer-host", () => ({
  sendToRenderer: (channel: string, payload: unknown) => sent(channel, payload),
}));

const server = (extra: Record<string, unknown> = {}): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set<string>(),
    workspacePath: () => null,
    ...extra,
  } as never);

type Executable = {
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    session?: string
  ) => Promise<{ content: { text?: string }[] }>;
};

/** The paths the broadcast carried, in the order they were sent. */
const present = async (
  items: { path: string; label?: string }[]
): Promise<string[]> => {
  await (
    server() as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("present_deliverable", { items }, "session-1");

  return sent.mock.calls.map((call) => (call[1] as { path: string }).path);
};

beforeEach(() => {
  sent.mockClear();
});

describe("presenting URLs", () => {
  it("opens the one it was given", async () => {
    expect(await present([{ path: "http://localhost:5173" }])).toEqual([
      "http://localhost:5173",
    ]);
  });

  it("opens only the first — the rest are rows of the files card", async () => {
    const paths = await present([
      { path: "http://localhost:5173" },
      { path: "http://localhost:5174" },
      { path: "http://localhost:5175" },
    ]);

    expect(paths).toEqual(["http://localhost:5173"]);
  });
});

describe("presenting from a bot's chat", () => {
  it("opens no pane, and says the card is where the file is", async () => {
    const result = await (
      server({
        botIdForSession: (session: string) =>
          session === "bot-session" ? "bot-1" : null,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "http://localhost:5173" }] },
      "bot-session"
    );

    expect(sent).not.toHaveBeenCalled();
    const text = result.content.map((part) => part.text ?? "").join("");
    expect(text).toContain("http://localhost:5173");
    expect(text).not.toContain("preview pane");
  });
});

describe("what the result declares", () => {
  it("is exactly the items that exist, one marker line each", async () => {
    const result = await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      {
        items: [
          { path: "http://localhost:5173", label: "The app" },
          { path: "/nowhere/user@a.com_user@b.com", label: "placeholder" },
          { path: "http://localhost:4000" },
        ],
      },
      "session-1"
    );

    const text = result.content.map((part) => part.text ?? "").join("");
    const declared = text
      .split("\n")
      .filter((line) => line.startsWith("[artifact] "));
    expect(declared).toEqual([
      "[artifact] http://localhost:5173",
      "[artifact] http://localhost:4000",
    ]);
    expect(text).toContain("Not presented, because there is no file");
  });
});

describe("presenting nothing that exists", () => {
  it("opens no pane and says so", async () => {
    const result = await (
      server() as unknown as {
        executeTool: (
          name: string,
          args: Record<string, unknown>,
          session?: string
        ) => Promise<{ content: { text?: string }[] }>;
      }
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "/nope/missing.pdf" }] },
      "session-1"
    );

    expect(sent).not.toHaveBeenCalled();
    expect(result.content.map((part) => part.text ?? "").join("")).toContain(
      "none of those exist"
    );
  });
});

describe("which pane it lands in", () => {
  it("names the caller's conversation, so it opens in that chat and no other", async () => {
    const key = sessionConversationKey("workspace-1", "session-1");
    await (
      server({
        conversationKeyForSession: (sessionId: string) =>
          sessionId === "session-1" ? key : null,
      }) as unknown as Executable
    ).executeTool(
      "present_deliverable",
      { items: [{ path: "http://localhost:5173" }] },
      "session-1"
    );

    expect(sent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "preview-open",
        path: "http://localhost:5173",
        conversationKey: key,
      })
    );
  });

  it("leaves the key off when the session is not known", async () => {
    await (server() as unknown as Executable).executeTool(
      "present_deliverable",
      { items: [{ path: "http://localhost:5173" }] },
      "session-1"
    );

    const payload = sent.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("conversationKey");
  });
});
