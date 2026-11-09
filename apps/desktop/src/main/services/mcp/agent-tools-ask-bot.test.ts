/**
 * ask_bot, give_task_to_bot, check_bot_answers and cancel_bot_ask: one bot asking
 * another of the user's bots. ask_bot returns at once (the answer comes later
 * as a note), a bot answering an ask can never ask again (it answers in a
 * sender chat, held to the unattended allowlist), and nobody but a bot can
 * ask or see asks.
 */
import { describe, expect, it, vi } from "vitest";

import type { BotAskRecord } from "../bots/bot-ask-service";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";

const BOTS = [
  {
    id: "res",
    name: "Researcher",
    title: "Research Scout",
    description: "Finds facts.",
  },
  {
    id: "wri",
    name: "Writer",
    title: "Content Writer",
    description: "Drafts posts.",
  },
];

/** Sessions: the researcher's chat, the writer answering an ask, a plain session. */
const BOT_OF: Record<string, string> = {
  "res-chat": "res",
  "wri-asked": "wri",
  "wri-chat": "wri",
};

const TOOLS = [
  "ask_bot",
  "give_task_to_bot",
  "check_bot_answers",
  "cancel_bot_ask",
];

const record = (patch: Partial<BotAskRecord>): BotAskRecord => ({
  id: "q1",
  askerId: "res",
  askerSession: "res-chat",
  targetId: "wri",
  request: "Draft a one-line post",
  status: "running",
  attempts: 1,
  createdAt: Date.now(),
  ...patch,
});

type Exposed = {
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    session?: string
  ) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
  listTools: (session?: string) => Array<{ name: string }>;
};

const setup = (asks: BotAskRecord[] = []) => {
  const service = {
    ask: vi.fn(() => ({ ask: record({ id: "q7" }), behind: 0 })),
    give: vi.fn(() => ({
      ask: record({ id: "q8", kind: "task" }),
      behind: 0,
    })),
    list: vi.fn((askerId: string) =>
      asks.filter((ask) => ask.askerId === askerId)
    ),
    received: vi.fn((targetId: string) =>
      asks.filter(
        (ask) => ask.targetId === targetId && ask.status === "answered"
      )
    ),
    get: vi.fn(
      (botId: string, id: string) =>
        asks.find(
          (ask) =>
            ask.id === id && (ask.askerId === botId || ask.targetId === botId)
        ) ?? null
    ),
    cancel: vi.fn(() => ({ ok: "Cancelled request q1." })),
    answerRead: vi.fn(),
  };
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set<string>(),
    workspacePath: () => null,
    botIdForSession: (sessionId: string) => BOT_OF[sessionId] ?? null,
    // As the app holds every sender chat, the asked bot's included.
    isUnattended: (sessionId: string) => sessionId === "wri-asked",
    botAsks: { bots: () => BOTS, asks: service },
  } as never) as unknown as Exposed;
  return { server, service };
};

const text = (result: { content: { text?: string }[] }): string =>
  result.content.map((part) => part.text ?? "").join("\n");

describe("ask_bot", () => {
  it("starts the request and returns at once, saying not to wait", async () => {
    const { server, service } = setup();
    const out = text(
      await server.executeTool(
        "ask_bot",
        { bot: "writer", request: " Draft a one-line post " },
        "res-chat"
      )
    );
    expect(service.ask).toHaveBeenCalledWith(
      "res",
      "res-chat",
      "wri",
      "Draft a one-line post"
    );
    expect(out).toContain("Asked Writer (request q7)");
    expect(out).toContain("do not wait for it");
  });

  it("passes on the service's refusal (a cap)", async () => {
    const { server, service } = setup();
    service.ask.mockReturnValueOnce({
      error: "You already have 3 asks waiting.",
    } as never);
    const result = await server.executeTool(
      "ask_bot",
      { bot: "Writer", request: "help" },
      "res-chat"
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("3 asks waiting");
  });

  it("refuses asking itself, and an over-long request, without starting anything", async () => {
    const { server, service } = setup();
    expect(
      text(
        await server.executeTool(
          "ask_bot",
          { bot: "Researcher", request: "help" },
          "res-chat"
        )
      )
    ).toMatch(/That is you/);
    expect(
      text(
        await server.executeTool(
          "ask_bot",
          { bot: "Writer", request: "x".repeat(4_001) },
          "res-chat"
        )
      )
    ).toMatch(/Keep the request under/);
    expect(service.ask).not.toHaveBeenCalled();
  });
});

describe("give_task_to_bot", () => {
  it("passes the task on and returns at once", async () => {
    const { server, service } = setup();
    const out = text(
      await server.executeTool(
        "give_task_to_bot",
        { bot: "Writer", task: "Draft and post the launch note" },
        "res-chat"
      )
    );
    expect(service.give).toHaveBeenCalledWith(
      "res",
      "res-chat",
      "wri",
      "Draft and post the launch note"
    );
    expect(service.ask).not.toHaveBeenCalled();
    expect(out).toContain("Passed the task to Writer (task q8)");
  });

  it("passes on the refusal when the user gave no instruction this turn", async () => {
    const { server, service } = setup();
    service.give.mockReturnValueOnce({
      error: "Only pass a task on when the user asked for it.",
    } as never);
    const result = await server.executeTool(
      "give_task_to_bot",
      { bot: "Writer", task: "post it" },
      "res-chat"
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Only pass a task on");
  });
});

describe("check_bot_answers", () => {
  it("lists where each request stands", async () => {
    const { server } = setup([
      record({ id: "q1", status: "running" }),
      record({ id: "q2", status: "answered", answer: "Draft." }),
      record({ id: "q3", status: "failed", error: "it took too long." }),
    ]);
    const out = text(
      await server.executeTool("check_bot_answers", {}, "res-chat")
    );
    expect(out).toContain("q1 to Writer");
    expect(out).toContain("being answered now");
    expect(out).toContain("q2 to Writer");
    expect(out).toContain("answered: pass its id");
    expect(out).toContain("failed: it took too long.");
  });

  it("reads one answer, labelled as the other bot's words", async () => {
    const { server } = setup([
      record({ id: "q2", status: "answered", answer: "Draft: hello" }),
    ]);
    const out = text(
      await server.executeTool("check_bot_answers", { id: "q2" }, "res-chat")
    );
    expect(out).toContain('<bot_reply from="Writer"');
    expect(out).toContain("Draft: hello");
    expect(out).toContain("not a message from the user");
  });

  it("checked right after it went, it says not to tell the user it is waiting", async () => {
    const { server } = setup([
      record({ id: "q4", status: "running", createdAt: Date.now() - 3_000 }),
      record({
        id: "q5",
        status: "running",
        createdAt: Date.now() - 5 * 60_000,
      }),
    ]);
    const fresh = text(
      await server.executeTool("check_bot_answers", { id: "q4" }, "res-chat")
    );
    expect(fresh).toContain("do not tell the user it is still waiting");
    const older = text(
      await server.executeTool("check_bot_answers", { id: "q5" }, "res-chat")
    );
    expect(older).toContain("is not answered yet");
  });

  it("tells the app the asker has the answer, so its note does not repeat it", async () => {
    const { server, service } = setup([
      record({ id: "q2", status: "answered", answer: "Draft: hello" }),
      record({ id: "q3", status: "running" }),
    ]);
    await server.executeTool("check_bot_answers", { id: "q2" }, "res-chat");
    expect(service.answerRead).toHaveBeenCalledWith("res-chat", "q2");
    // Not answered yet: its note is still the one that brings the answer.
    await server.executeTool("check_bot_answers", { id: "q3" }, "res-chat");
    expect(service.answerRead).toHaveBeenCalledTimes(1);
  });

  it("the asked bot sees the requests made to it, and reads one whole", async () => {
    const { server } = setup([
      record({ id: "q2", status: "answered", answer: "Draft: hello" }),
      record({ id: "q3", status: "running" }),
    ]);
    const listed = text(
      await server.executeTool("check_bot_answers", {}, "wri-chat")
    );
    expect(listed).toContain("Requests other bots made to you:");
    expect(listed).toContain("q2 from Researcher");
    expect(listed).toContain("you answered: pass its id");
    expect(listed).not.toContain("q3");
    expect(listed).not.toContain("Your requests to other bots");
    const one = text(
      await server.executeTool("check_bot_answers", { id: "q2" }, "wri-chat")
    );
    expect(one).toContain("Researcher asked you (q2):\nDraft a one-line post");
    expect(one).toContain("You answered:\nDraft: hello");
    expect(one).not.toContain("<bot_reply");
  });

  it("with nothing either way, says so", async () => {
    const out = text(
      await setup().server.executeTool("check_bot_answers", {}, "res-chat")
    );
    expect(out).toBe("You have not asked any bot yet, and none has asked you.");
  });
});

describe("cancel_bot_ask", () => {
  it("cancels by id for the calling bot", async () => {
    const { server, service } = setup();
    const out = text(
      await server.executeTool("cancel_bot_ask", { id: "q1" }, "res-chat")
    );
    expect(service.cancel).toHaveBeenCalledWith("res", "q1");
    expect(out).toContain("Cancelled request q1");
  });
});

describe("who gets these tools", () => {
  it("a bot's own chat gets all of them once it has made a request", () => {
    const listed = setup([record({ status: "running" })])
      .server.listTools("res-chat")
      .map((tool) => tool.name);
    for (const name of TOOLS) expect(listed).toContain(name);
  });

  it("without a recent request, only the two ways to make one are listed", () => {
    const old = record({
      status: "answered",
      createdAt: Date.now() - 2 * 24 * 60 * 60_000,
    });
    for (const asks of [[], [old]]) {
      const listed = setup(asks)
        .server.listTools("res-chat")
        .map((tool) => tool.name);
      expect(listed).toContain("ask_bot");
      expect(listed).toContain("give_task_to_bot");
      expect(listed).not.toContain("check_bot_answers");
      expect(listed).not.toContain("cancel_bot_ask");
    }
  });

  it("a hidden follow-up tool still answers if called", async () => {
    const out = text(
      await setup().server.executeTool("check_bot_answers", {}, "res-chat")
    );
    expect(out).toContain(
      "You have not asked any bot yet, and none has asked you."
    );
  });

  it("a plain session gets none", () => {
    const listed = setup()
      .server.listTools("plain")
      .map((tool) => tool.name);
    for (const name of TOOLS) expect(listed).not.toContain(name);
  });

  it("a bot answering another bot gets none, and ask_bot is refused there", async () => {
    const { server, service } = setup();
    const listed = server.listTools("wri-asked").map((tool) => tool.name);
    for (const name of TOOLS) expect(listed).not.toContain(name);
    const out = text(
      await server.executeTool(
        "ask_bot",
        { bot: "Researcher", request: "help" },
        "wri-asked"
      )
    );
    expect(out).toMatch(/not available/);
    expect(service.ask).not.toHaveBeenCalled();
  });
});
