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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getJob, listJobs, recordRun } from "../agent-tools/cron-store";
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
): Promise<string[]> =>
  (
    instance as unknown as {
      listTools: (callerSession?: string) => Array<{ name: string }>;
    }
  )
    .listTools(session)
    .map((entry) => entry.name);

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
describe("the folder of a routine a chat makes", () => {
  it("is the project of that chat, whatever the app has open", async () => {
    const asked: (string | undefined)[] = [];
    const instance = server(["cronjob"], {
      workspaceId: (sessionId?: string) => {
        asked.push(sessionId);
        return sessionId === "chat-in-project" ? "project-1" : null;
      },
    });
    const make = (name: string, schedule: string, session: string) =>
      call(
        instance,
        { action: "create", schedule, prompt: name, name, firstRun: false },
        session
      );

    await make("Sales digest", "0 9 * * 1", "chat-in-project");
    await make("Rain alert", "0 7 * * *", "plain-chat");

    expect(asked).toEqual(["chat-in-project", "plain-chat"]);
    expect(listJobs().map((job) => [job.name, job.workspaceId])).toEqual([
      ["Sales digest", "project-1"],
      ["Rain alert", null],
    ]);
  });
});

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
        schedule: "*/5 * * * *",
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

  it("does not fire when the caller has just done the first pass itself", async () => {
    const runner = spy();
    const text = await call(
      server([], { runCronJob: runner.runCronJob }),
      {
        action: "create",
        schedule: "0 8 * * *",
        prompt: "Draft replies to yesterday's mail.",
        firstRun: false,
      },
      "bot-session"
    );

    expect(runner.fires).toHaveLength(0);
    expect(text).toContain("Created.");
    expect(text).not.toContain("The first one is running now");
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

/**
 * `list` hid other owners' routines, but every id-taking action took any id:
 * a bot that read one off the Routines panel could pause, rewrite or fire
 * the user's routine.
 */
describe("what a bot may do to routines that are not its own", () => {
  const userJobId = async (instance: ReturnType<typeof server>) => {
    const text = await call(
      instance,
      { action: "create", schedule: "*/3 * * * *", prompt: "Pickup lines" },
      "session-1"
    );
    return text.match(/(job-[\w-]+)/)![1]!;
  };

  it("cannot pause, rewrite, remove or fire the user's routine", async () => {
    const runner = { runCronJob: vi.fn(async () => undefined) };
    const instance = server(["cronjob"], runner);
    const id = await userJobId(instance);
    // The user's create fired once, as every create does.
    runner.runCronJob.mockClear();

    for (const action of ["pause", "resume", "update", "remove", "run"]) {
      const text = await call(
        instance,
        { action, id, ...(action === "update" ? { prompt: "hijacked" } : {}) },
        "bot-session"
      );
      expect(text).toContain("not yours");
    }
    expect(runner.runCronJob).not.toHaveBeenCalled();
    expect(await call(instance, { action: "list" }, "session-1")).toContain(
      "Pickup lines"
    );
  });

  it("changes the user's routine in the user's own chat with it, and nowhere else", async () => {
    const roles: Record<string, string> = { "bot-session": "forever" };
    const instance = server(["cronjob"], {
      sessionRole: (sessionId: string) => roles[sessionId] ?? null,
    });
    const id = await userJobId(instance);

    const listed = await call(instance, { action: "list" }, "bot-session");
    expect(listed).toContain("Pickup lines");
    expect(listed).toContain("only when the user asks");
    expect(
      await call(instance, { action: "pause", id }, "bot-session")
    ).not.toContain("not yours");

    // Someone else's chat with the bot reaches no routine at all.
    roles["bot-session"] = "sender";
    expect(
      await call(instance, { action: "resume", id }, "bot-session")
    ).toContain("not from a chat with someone else");
  });

  it("may still run its own", async () => {
    const runner = { runCronJob: vi.fn(async () => undefined) };
    const instance = server(["cronjob"], runner);
    const text = await call(
      instance,
      { action: "create", schedule: "0 9 * * 1", prompt: "Monday brief" },
      "bot-session"
    );
    const id = text.match(/(job-[\w-]+)/)![1]!;
    runner.runCronJob.mockClear();

    expect(
      await call(instance, { action: "pause", id }, "bot-session")
    ).not.toContain("not yours");
  });
});

describe("a first fire that could not start", () => {
  it("is not called running: the model is told to do the pass itself", async () => {
    const runner = { runCronJob: vi.fn(async () => "skipped" as const) };
    const text = await call(
      server([], runner),
      { action: "create", schedule: "0 9 * * *", prompt: "Morning brief" },
      "bot-session"
    );

    expect(text).not.toContain("The first one is running now");
    expect(text).toContain("could not start right now");
  });
});

describe("a one-time routine", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 20, 13, 35) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is made from in_minutes, fires at its moment and not on creation", async () => {
    const runner = { runCronJob: vi.fn(async () => "started" as const) };
    const text = await call(
      server([], runner),
      {
        action: "create",
        in_minutes: 1,
        prompt: "Remind me to stretch.",
        name: "Stretch",
      },
      "bot-session"
    );

    expect(text).toContain("It runs once, at");
    expect(runner.runCronJob).not.toHaveBeenCalled();
    const [job] = listJobs();
    expect(job?.schedule).toBeNull();
    expect(job?.runAt).toBe(new Date(2026, 9, 20, 13, 36).getTime());
  });

  it("is made from run_at in this computer's local time", async () => {
    await call(
      server(),
      { action: "create", run_at: "2026-10-21T08:20", prompt: "Alert me." },
      "bot-session"
    );

    expect(listJobs()[0]?.runAt).toBe(new Date(2026, 9, 21, 8, 20).getTime());
  });

  it("runs a moment that has passed once now, and reads a date alone as the morning", async () => {
    const runner = { runCronJob: vi.fn(async () => "started" as const) };
    const instance = server([], runner);
    const past = await call(
      instance,
      { action: "create", run_at: "2026-10-20T09:00", prompt: "x" },
      "bot-session"
    );
    expect(past).toContain("Created.");
    expect(past).toContain("runs once now");
    expect(listJobs()[0]?.runAt).toBe(new Date(2026, 9, 20, 13, 35).getTime());
    const dateOnly = await call(
      instance,
      { action: "create", run_at: "2026-10-21", prompt: "y" },
      "bot-session"
    );
    expect(dateOnly).toContain("has no time");
    expect(listJobs().map((job) => job.runAt)).toContain(
      new Date(2026, 9, 21, 9).getTime()
    );
  });

  it("keeps an every-minute schedule, and warns, pointing to in_minutes", async () => {
    const text = await call(
      server(),
      {
        action: "create",
        schedule: "* * * * *",
        prompt: "Remind the user to drink water.",
        name: "Water reminder",
      },
      "bot-session"
    );

    expect(text).toContain("Created.");
    expect(text).toContain("fires every minute");
    expect(text).toContain("in_minutes");
    expect(listJobs()[0]?.schedule).toBe("* * * * *");
  });

  it("keeps a yearly routine pinned to one date", async () => {
    await call(
      server(),
      { action: "create", schedule: "0 9 14 2 *", prompt: "Anniversary note" },
      "bot-session"
    );

    expect(listJobs()[0]?.schedule).toBe("0 9 14 2 *");
  });

  it("uses run_at when in_minutes is given too, and says in_minutes was left out", async () => {
    const text = await call(
      server(),
      {
        action: "create",
        run_at: "2026-10-21T08:20",
        in_minutes: 5,
        prompt: "x",
      },
      "bot-session"
    );

    expect(text).toContain("run_at was used");
    expect(listJobs()[0]?.runAt).toBe(new Date(2026, 9, 21, 8, 20).getTime());
  });

  it("leaves a repeating routine's fire on creation as it is", async () => {
    const runner = { runCronJob: vi.fn(async () => "started" as const) };
    await call(
      server([], runner),
      { action: "create", schedule: "0 7 * * *", prompt: "Morning brief" },
      "bot-session"
    );

    expect(runner.runCronJob).toHaveBeenCalledWith(
      expect.stringMatching(/^job-/),
      "create"
    );
  });
});

describe("a run the agent asks for", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 13, 8, 0) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A runner that writes each run down, as the host does. */
  const recording = () => ({
    runCronJob: vi.fn(async (id: string, trigger?: string) => {
      recordRun(id, "started session s", (trigger ?? "manual") as never, {
        kind: "started",
      });
      return "started" as const;
    }),
  });

  const make = async (instance: McpAgentToolsServer): Promise<string> => {
    const text = await call(
      instance,
      {
        action: "create",
        schedule: "30 18 * * *",
        prompt: "Next phase of the project plan",
        firstRun: false,
      },
      "bot-session"
    );
    return text.match(/(job-[\w-]+)/)![1]!;
  };

  it("is filed as the agent's, and started again within ten minutes with a warning", async () => {
    const runner = recording();
    const instance = server([], runner);
    const id = await make(instance);

    const first = await call(instance, { action: "run", id }, "bot-session");
    expect(first).toContain("Started");
    expect(first).not.toContain("Note:");
    expect(runner.runCronJob).toHaveBeenLastCalledWith(id, "agent");
    vi.setSystemTime(new Date(2026, 9, 13, 8, 5));
    const again = await call(instance, { action: "run", id }, "bot-session");

    expect(again).toContain("Started");
    expect(again).toContain("already ran 5 minutes ago");
    expect(again).toContain("unless the user asked");
    expect(runner.runCronJob).toHaveBeenCalledTimes(2);
  });

  it("still starts past a few a day, saying how many", async () => {
    const runner = recording();
    const instance = server([], runner);
    const id = await make(instance);

    for (const hour of [8, 9, 10]) {
      vi.setSystemTime(new Date(2026, 9, 13, hour, 0));
      await call(instance, { action: "run", id }, "bot-session");
    }
    vi.setSystemTime(new Date(2026, 9, 13, 11, 0));
    const fourth = await call(instance, { action: "run", id }, "bot-session");

    expect(fourth).toContain("Started");
    expect(fourth).toMatch(/you have run it 3 times today/i);
    expect(runner.runCronJob).toHaveBeenCalledTimes(4);
  });

  it("says what really happened when the run did not start", async () => {
    const instance = server([], {
      runCronJob: vi.fn(async (id: string) => {
        recordRun(id, "skipped: the previous run is still going", "agent", {
          kind: "skipped",
        });
        return "skipped" as const;
      }),
    });
    const id = await make(instance);

    const text = await call(instance, { action: "run", id }, "bot-session");

    expect(text).toContain("Not started");
    expect(text).toContain("still going");
    expect(text).not.toContain("Started");
    expect(getJob(id)?.runs).toHaveLength(1);
  });
});
