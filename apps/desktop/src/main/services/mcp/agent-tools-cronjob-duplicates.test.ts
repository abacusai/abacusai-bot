/**
 * `cronjob` create never makes a routine twice: the app decides, not the
 * model. Hosted runs go through a fake server that keeps rows and honours the
 * idempotency key, and can finish a create after the client stopped waiting.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { CHECK_IN_PROMPT } from "@abacus-ai/contract/bots/check-in";
import type { Routine, RoutineCreateInput } from "@abacus-ai/contract/routines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJob, listJobs } from "../agent-tools/cron-store";
import {
  HostedRoutines,
  type HostedRoutineWire,
} from "../agent-tools/hosted-routines";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-cron-dup-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const local = (
  options: { bot?: string | null; missionEdited?: boolean } = {}
) => {
  const hosted = new HostedRoutines({
    call: async () => ({ ok: false, status: 404, body: {} }),
    hasKey: () => true,
  });
  const runCronJob = vi.fn(async () => "started" as const);
  const funnel = vi.fn();
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["cronjob"]),
    workspacePath: () => null,
    workspaceId: () => null,
    botIdForSession: () => options.bot ?? null,
    missionJustEdited: () => options.missionEdited === true,
    funnel,
    sessionRole: () => (options.bot != null ? "forever" : null),
    runCronJob,
    routines: {
      defaultRunner: () => "local",
      create: async (input: RoutineCreateInput) => createJob(input),
      hosted,
    },
  } as never);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const result = (await server.executeTool("cronjob", args, "s1")) as {
      content: Array<{ text?: string }>;
    };
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  return { call, runCronJob, funnel };
};

/** The account's rows on the server, as `/abacusaibot_routines` keeps them. */
const fakeServer = () => {
  const rows: Array<HostedRoutineWire & { key?: string }> = [];
  /** How many coming creates land, but answer only after the client gave up. */
  const slow = { creates: 0 };
  const call = async (body: Record<string, unknown>) => {
    if (body.action === "capabilities")
      return { ok: true as const, body: { hosted_routines: true } };
    if (body.action === "list")
      return { ok: true as const, body: { routines: rows } };
    if (body.action !== "create") return { ok: true as const, body: {} };
    const key = body.idempotency_key as string;
    let row = rows.find((entry) => entry.key === key);
    if (row == null) {
      row = {
        id: `r${rows.length + 1}`,
        key,
        kind: body.kind as "task",
        name: body.name as string,
        prompt: body.prompt as string,
        schedule: body.schedule as HostedRoutineWire["schedule"],
        status: "active",
        owner_bot_id: (body.owner_bot_id as string | undefined) ?? null,
      };
      rows.push(row);
    }
    if (slow.creates > 0) {
      slow.creates -= 1;
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError"
      );
    }
    return { ok: true as const, body: { routine: row } };
  };
  return { rows, slow, call };
};

const hostedHost = (server: ReturnType<typeof fakeServer>) => {
  const hosted = new HostedRoutines({ call: server.call, hasKey: () => true });
  const tools = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["cronjob"]),
    workspacePath: () => null,
    workspaceId: () => null,
    botIdForSession: () => null,
    sessionRole: () => null,
    routines: {
      defaultRunner: () => "hosted",
      hostedOnly: () => true,
      // As ServiceHost.createRoutine: a create with no id gets a fresh key.
      create: async (input: RoutineCreateInput): Promise<Routine> =>
        hosted.create({
          kind: "task",
          name: input.name ?? "",
          prompt: input.prompt,
          cron: input.schedule ?? null,
          timezone: input.timezone ?? null,
          idempotencyKey: randomUUID(),
        }),
      hosted,
    },
  } as never);
  return async (args: Record<string, unknown>): Promise<string> => {
    const result = (await tools.executeTool("cronjob", args, "s1")) as {
      content: Array<{ text?: string }>;
    };
    return result.content.map((part) => part.text ?? "").join("\n");
  };
};

const BRIEF = {
  action: "create",
  name: "Morning brief",
  prompt: "Summarize my inbox and my calendar for today.",
  schedule: "0 8 * * *",
};

describe("cronjob create, the same routine twice", () => {
  it("gives the existing routine back, makes one, and fires nothing", async () => {
    const { call, runCronJob, funnel } = local();
    await call(BRIEF);
    expect(runCronJob).toHaveBeenCalledTimes(1);

    const text = await call(BRIEF);

    expect(listJobs()).toHaveLength(1);
    expect(runCronJob).toHaveBeenCalledTimes(1);
    expect(text).toContain("[already set up: nothing was created]");
    expect(text).toContain(listJobs()[0]!.id);
    expect(text).toContain("in their language");
    expect(funnel).toHaveBeenCalledWith(
      "routine_duplicate_avoided",
      "same-local"
    );
  });

  it("makes one from two calls in one model step", async () => {
    const { call } = local();
    await Promise.all([call(BRIEF), call(BRIEF)]);
    expect(listJobs()).toHaveLength(1);
  });

  it("says when the routine is paused, rather than making a running copy", async () => {
    const { call } = local();
    await call(BRIEF);
    await call({ action: "pause", id: listJobs()[0]!.id });
    expect(await call(BRIEF)).toContain("It is paused");
    expect(listJobs()).toHaveLength(1);
  });

  it("finds one written outside this tool, under another name and wording", async () => {
    const { call } = local({ bot: "bot-1" });
    createJob({
      name: "Channel watch",
      botId: "bot-1",
      schedule: "0,30 6-22 * * *",
      prompt:
        "Every 30 minutes, read #team-updates for messages that name you and reply in the thread.",
    });

    const text = await call({
      action: "create",
      name: "Channel check",
      schedule: "*/30 6-22 * * *",
      prompt:
        "Look at #team-updates since your last check. Answer tasks addressed to you.",
    });

    expect(text).toContain("[already set up: nothing was created]");
    expect(listJobs()).toHaveLength(1);
  });
});

describe("cronjob create, a different routine", () => {
  it.each([
    ["a different schedule", { schedule: "0 18 * * *" }],
    [
      "a different job at the same time",
      { name: "Backup", prompt: "Back up the project folder to the drive." },
    ],
    ["a one-time run", { schedule: undefined, in_minutes: 30 }],
  ])("makes %s", async (_label, change) => {
    const { call } = local();
    await call(BRIEF);
    expect(await call({ ...BRIEF, ...change })).toMatch(/^Created\./);
    expect(listJobs()).toHaveLength(2);
  });

  it("makes another bot's, even in the same words", async () => {
    createJob({ ...BRIEF, botId: "bot-2" });
    await local({ bot: "bot-1" }).call(BRIEF);
    expect(listJobs()).toHaveLength(2);
  });

  it("makes one the maker read and says is separate, unless it is word for word", async () => {
    const { call } = local();
    await call(BRIEF);
    const id = listJobs()[0]!.id;
    const similar = {
      ...BRIEF,
      prompt: "Summarize my inbox and my calendar for tomorrow.",
    };

    expect(await call(similar)).toContain(`distinct_from: "${id}"`);
    expect(listJobs()).toHaveLength(1);

    await call({ ...BRIEF, distinct_from: id });
    expect(listJobs()).toHaveLength(1);

    await call({ ...similar, distinct_from: id });
    expect(listJobs()).toHaveLength(2);
  });
});

describe("cronjob create, after a mission edit", () => {
  const checkIn = () =>
    createJob({
      name: "Scout check-in",
      botId: "bot-1",
      schedule: "0 * * * *",
      prompt: CHECK_IN_PROMPT,
    });
  /** What a bot made of "every hour" in its edited mission, in its own words. */
  const hourly = {
    action: "create",
    name: "Hourly sweep",
    schedule: "0 * * * *",
    firstRun: false,
    prompt: "Check the inbox and the team channel for anything new, and act.",
  };

  it("keeps the one check-in when the bot turns the new schedule into a routine", async () => {
    const { call, funnel } = local({ bot: "bot-1", missionEdited: true });
    checkIn();

    const text = await call(hourly);

    expect(listJobs()).toHaveLength(1);
    expect(text).toContain("This is your check-in");
    expect(text).toContain("Leave its prompt as it is");
    expect(funnel).toHaveBeenCalledWith(
      "routine_duplicate_avoided",
      "check-in-local"
    );
  });

  it("keeps it on any minute of the hour, for a routine called a check-in", async () => {
    const { call } = local({ bot: "bot-1" });
    createJob({
      name: "Scout check-in",
      botId: "bot-1",
      schedule: "8 * * * *",
      prompt: CHECK_IN_PROMPT,
    });

    await call({ ...hourly, name: "Hourly check-in" });

    expect(listJobs()).toHaveLength(1);
  });

  it("sends a job moved to a new time to update, instead of adding one", async () => {
    const { call } = local({ bot: "bot-1", missionEdited: true });
    await call({ ...BRIEF, firstRun: false });

    const text = await call({ ...BRIEF, schedule: "0 9 * * *" });

    expect(listJobs()).toHaveLength(1);
    expect(listJobs()[0]!.schedule).toBe("0 8 * * *");
    expect(text).toContain(`"update" this one (id ${listJobs()[0]!.id})`);
  });

  it("still makes a job the check-in does not cover, outside an edit", async () => {
    const { call } = local({ bot: "bot-1" });
    checkIn();
    await call(hourly);
    expect(listJobs()).toHaveLength(2);
  });

  it("will not let a bot rewrite its check-in's prompt, which the settings find it by", async () => {
    const { call } = local({ bot: "bot-1" });
    const job = checkIn();

    const text = await call({ action: "update", id: job.id, prompt: "Other." });

    expect(text).toContain("your check-in");
    expect(listJobs()[0]!.prompt).toBe(CHECK_IN_PROMPT);
    await call({ action: "update", id: job.id, schedule: "0 9 * * *" });
    expect(listJobs()[0]!.schedule).toBe("0 9 * * *");
  });
});

describe("cronjob create, a hosted create that timed out", () => {
  const create = { ...BRIEF, runner: "hosted", timezone: "Asia/Kolkata" };

  it("is one routine when the retry repeats it word for word", async () => {
    const server = fakeServer();
    const call = hostedHost(server);
    server.slow.creates = 1;

    const first = await call(create);
    expect(first).toContain("[not confirmed]");

    await call(create);
    expect(server.rows).toHaveLength(1);
  });

  it("is one routine when the model rewords the retry", async () => {
    const server = fakeServer();
    const call = hostedHost(server);
    server.slow.creates = 1;
    await call(create);

    await call({
      ...create,
      prompt: "Give me my inbox and calendar for today.",
    });

    expect(server.rows).toHaveLength(1);
  });

  it("still makes a different one after it", async () => {
    const server = fakeServer();
    const call = hostedHost(server);
    server.slow.creates = 1;
    await call(create);

    await call({
      ...create,
      name: "Evening wrap",
      prompt: "Write up what got done today.",
      schedule: "0 18 * * *",
    });

    expect(server.rows).toHaveLength(2);
  });
});
