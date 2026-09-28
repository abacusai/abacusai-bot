/**
 * `cronjob`: bots get it whatever the Capabilities toggle says.
 *
 * The toolset ships off by default because scheduling unattended runs is
 * reach a session should not have unasked. A bot's routines are different in
 * exactly the way that rationale cares about: created in the bot's own chat
 * when the user asks, listed in the Routines panel, fired back into the same
 * visible conversation. So a bot caller is served the tool even with the
 * toolset off, while a session still is not: "send me a daily summary"
 * has to work in the one chat where it is most natural to ask.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-cron-bots-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

/** `bot-session` belongs to a bot; every other session id does not. */
const server = (
  enabled: string[] = [],
  extra: Record<string, unknown> = {}
): McpAgentToolsServer =>
  new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(enabled),
    workspacePath: () => null,
    workspaceId: () => null,
    botIdForSession: (sessionId: string) =>
      sessionId === "bot-session" ? "bot-1" : null,
    ...extra,
  } as never);

const listedTools = async (
  instance: McpAgentToolsServer,
  session?: string
): Promise<string[]> => {
  const response = (await (
    instance as unknown as {
      processJsonRpc: (
        request: unknown,
        callerSession?: string
      ) => Promise<{ result: { tools: { name: string }[] } }>;
    }
  ).processJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    session
  )) as { result: { tools: { name: string }[] } };

  return response.result.tools.map((entry) => entry.name);
};

const call = async (
  instance: McpAgentToolsServer,
  args: Record<string, unknown>,
  session?: string
): Promise<string> => {
  const result = await (
    instance as unknown as {
      executeTool: (
        name: string,
        args: Record<string, unknown>,
        session?: string
      ) => Promise<{ content: { text?: string }[] }>;
    }
  ).executeTool("cronjob", args, session);

  return result.content.map((part) => part.text ?? "").join("\n");
};

describe("with the cronjob toolset switched off", () => {
  it("still offers the tool to a bot's chat", async () => {
    expect(await listedTools(server(), "bot-session")).toContain("cronjob");
  });

  it("lets the bot create a routine, owned by the bot", async () => {
    const text = await call(
      server(),
      {
        action: "create",
        schedule: "0 8 * * 1-5",
        prompt: "Summarize the day's meetings.",
        name: "Daily brief",
      },
      "bot-session"
    );

    expect(text).toContain("counts as one of yours");
  });

  it("does not offer the tool to a session", async () => {
    const tools = await listedTools(server(), "session-1");

    expect(tools).not.toContain("cronjob");
  });

  it("refuses a session even holding an older tool list", async () => {
    expect(await call(server(), { action: "list" }, "session-1")).toContain(
      "switched off in Capabilities"
    );
  });

  it("treats a caller with no session as a session", async () => {
    expect(await listedTools(server())).not.toContain("cronjob");
    expect(await call(server(), { action: "list" })).toContain(
      "switched off in Capabilities"
    );
  });
});

describe("with the cronjob toolset switched on", () => {
  it("serves sessions as before", async () => {
    const instance = server(["cronjob"]);

    expect(await listedTools(instance, "session-1")).toContain("cronjob");
    expect(await call(instance, { action: "list" }, "session-1")).toContain(
      "No routines yet."
    );
  });
});

/**
 * A bot's `list` is scoped to its own routines. Every routine on the machine
 * used to come back, and a freshly created bot reading the room adopted the
 * user's unrelated schedules as its own mission backlog, greeting the user
 * with plans to run them.
 */
describe("what a bot sees in the routine list", () => {
  it("lists only its own routines, and counts the rest", async () => {
    const instance = server(["cronjob"]);
    // One routine of the user's (from a plain session)...
    await call(
      instance,
      { action: "create", schedule: "*/3 * * * *", prompt: "Pickup lines" },
      "session-1"
    );
    // ...and one of the bot's own.
    await call(
      instance,
      { action: "create", schedule: "0 9 * * 1", prompt: "Monday brief" },
      "bot-session"
    );

    const text = await call(instance, { action: "list" }, "bot-session");
    expect(text).toContain("Monday brief");
    expect(text).not.toContain("Pickup lines");
    expect(text).toContain("1 other routine");
  });

  it("tells a bot with nothing scheduled that, not the user's list", async () => {
    const instance = server(["cronjob"]);
    await call(
      instance,
      { action: "create", schedule: "*/3 * * * *", prompt: "Pickup lines" },
      "session-1"
    );

    const text = await call(instance, { action: "list" }, "bot-session");
    expect(text).toContain("No routines of yours yet.");
    expect(text).not.toContain("Pickup lines");
  });

  it("still shows a session everything", async () => {
    const instance = server(["cronjob"]);
    await call(
      instance,
      { action: "create", schedule: "0 9 * * 1", prompt: "Monday brief" },
      "bot-session"
    );

    const text = await call(instance, { action: "list" }, "session-1");
    expect(text).toContain("Monday brief");
  });
});

/**
 * A routine that says nothing until its first tick is indistinguishable from
 * one that quietly did not take, so every schedule runs once on creation.
 */
describe("the first fire of a new routine", () => {
  const spy = (): {
    fires: { id: string; trigger: string | undefined }[];
    runCronJob: (id: string, trigger?: string) => Promise<void>;
  } => {
    const fires: { id: string; trigger: string | undefined }[] = [];
    return {
      fires,
      runCronJob: (id, trigger) => {
        fires.push({ id, trigger });
        return Promise.resolve();
      },
    };
  };

  it("fires a new routine at once, as a create", async () => {
    const runner = spy();
    const text = await call(
      server([], { runCronJob: runner.runCronJob }),
      {
        action: "create",
        schedule: "*/1 * * * *",
        prompt: "Tell a joke.",
        name: "Joke",
      },
      "bot-session"
    );

    expect(runner.fires).toHaveLength(1);
    expect(runner.fires[0]?.trigger).toBe("create");
    expect(text).toContain("The first one is running now");
    // The double-send guard: the fire performs the task, so the creating
    // agent is told in the same breath not to also do it: a bot once sent
    // the meeting summary itself while the first fire sent it in parallel.
    expect(text).toContain("do NOT also do that task");
  });

  it("fires one pinned to a time of day too, not only an interval", async () => {
    const runner = spy();
    const text = await call(
      server([], { runCronJob: runner.runCronJob }),
      {
        action: "create",
        schedule: "0 9 * * *",
        prompt: "Summarize the day's meetings.",
      },
      "bot-session"
    );

    expect(runner.fires).toHaveLength(1);
    expect(text).toContain("The first one is running now");
  });

  it("fires one restricted to work hours, off its own schedule", async () => {
    const runner = spy();
    await call(
      server([], { runCronJob: runner.runCronJob }),
      { action: "create", schedule: "*/15 9-17 * * 1-5", prompt: "Check CI." },
      "bot-session"
    );

    expect(runner.fires).toHaveLength(1);
  });

  it("keeps the routine when its first fire cannot start", async () => {
    const instance = server([], {
      runCronJob: () => Promise.reject(new Error("no workspace")),
    });
    const text = await call(
      instance,
      { action: "create", schedule: "*/5 * * * *", prompt: "Tell a joke." },
      "bot-session"
    );

    expect(text).toContain("Created.");
    expect(text).not.toContain("The first one is running now");
    expect(await call(instance, { action: "list" }, "bot-session")).toContain(
      "Tell a joke."
    );
  });

  it("does not fire a webhook-only routine, which has no schedule", async () => {
    const runner = spy();
    await call(
      server([], { runCronJob: runner.runCronJob }),
      { action: "create", webhook: true, prompt: "Handle the POST." },
      "bot-session"
    );

    expect(runner.fires).toEqual([]);
  });
});

/**
 * Renaming used to be create-only, and a real routine paid for it: a bot
 * repurposed "History trivia every 5 min" to send geography, changed the
 * prompt, saw that the name no longer matched, and, having no way to fix it,
 * told itself the name was "just a label". The panel and every `list` the
 * model reads back kept describing the old job.
 */
describe("renaming a routine", () => {
  const create = (instance: McpAgentToolsServer): Promise<string> =>
    call(
      instance,
      {
        action: "create",
        schedule: "*/5 * * * *",
        prompt: "Send a history trivia fact.",
        name: "History trivia every 5 min",
      },
      "bot-session"
    );

  const idFrom = (text: string): string => {
    const id = /job-[\w-]+/.exec(text)?.[0];
    if (id == null) throw new Error(`no job id in: ${text}`);
    return id;
  };

  it("takes a new name alongside the new prompt", async () => {
    const instance = server();
    const id = idFrom(await create(instance));

    const text = await call(
      instance,
      {
        action: "update",
        id,
        prompt: "Send a geography trivia fact.",
        name: "Geography trivia every 5 min",
      },
      "bot-session"
    );

    expect(text).toContain("Geography trivia every 5 min");
    expect(text).not.toContain("History trivia");
  });

  it("takes a rename on its own, with nothing else changing", async () => {
    const instance = server();
    const id = idFrom(await create(instance));

    const text = await call(
      instance,
      { action: "update", id, name: "Trivia" },
      "bot-session"
    );

    expect(text).toContain("Trivia");
    expect(text).toContain("Send a history trivia fact.");
  });

  it("still refuses an update that changes nothing, and says a name would do", async () => {
    const instance = server();
    const id = idFrom(await create(instance));

    const text = await call(instance, { action: "update", id }, "bot-session");

    expect(text).toContain("Nothing to update");
    expect(text).toContain("name");
  });
});

describe("the routine editor's session", () => {
  const editor = server([], {
    routineEditorFor: (sessionId: string) =>
      sessionId === "editor-session" ? "job-1" : null,
  });

  it("sees the cron tool and nothing else, whatever is switched on", async () => {
    expect(await listedTools(editor, "editor-session")).toEqual(["cronjob"]);
    // Unchanged for everyone else: cron stays off for a plain session.
    expect(await listedTools(editor, "plain-session")).not.toContain("cronjob");
  });

  it("can run the cron tool with cron switched off, and no other tool", async () => {
    expect(await call(editor, { action: "list" }, "editor-session")).toContain(
      "No routines"
    );
    expect(await call(editor, { action: "list" }, "plain-session")).toContain(
      "switched off"
    );
  });
});
