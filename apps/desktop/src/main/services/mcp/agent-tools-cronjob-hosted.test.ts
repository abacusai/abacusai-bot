/**
 * `cronjob` with a runner choice: a hosted routine is created on the server
 * (never fired on create), a local one exactly as before, and a free plan's
 * refusal comes back as an instruction to the model, never as text for the
 * user.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { WHATSAPP_CHANNEL } from "@abacus-ai/agent/channel";
import type {
  Routine,
  RoutineCreateInput,
  RoutineListItem,
} from "@abacus-ai/contract/routines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJob, listJobs } from "../agent-tools/cron-store";
import {
  HostedRoutineRefusal,
  HostedRoutines,
  toRoutineListItem,
} from "../agent-tools/hosted-routines";
import { McpAgentToolsServer } from "./mcp-agent-tools-server";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-cron-hosted-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const ROW: RoutineListItem = toRoutineListItem({
  id: "r1",
  kind: "task",
  name: "Morning digest",
  prompt: "My calendar",
  schedule: { cron: "0 8 * * *", timezone: "Asia/Kolkata" },
  enabled: true,
});
const BOT_ROW: RoutineListItem = toRoutineListItem({
  id: "r2",
  kind: "task",
  name: "Bot digest",
  prompt: "News",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  enabled: true,
  owner_bot_id: "bot-1",
});
const harness = (options: {
  phone?: boolean;
  defaultRunner?: "local" | "hosted";
  create?: (input: RoutineCreateInput) => Promise<Routine>;
  /** The caller: the user, a bot's own chat, or a bot's chat with someone else. */
  caller?: "user" | "bot" | "sender";
  created?: RoutineListItem;
  /** The once-per-user 24/7 note's plan, as the host claims it. */
  alwaysOn?: "paid" | null;
}) => {
  const hosted = new HostedRoutines({
    call: async () => ({ ok: false, status: 404, body: {} }),
    hasKey: () => true,
  });
  vi.spyOn(hosted, "list").mockReturnValue([ROW, BOT_ROW]);
  vi.spyOn(hosted, "find").mockReturnValue(options.created ?? ROW);
  const create = vi.fn<
    (input: RoutineCreateInput, options?: unknown) => Promise<Routine>
  >(
    options.create ??
      (async (input: RoutineCreateInput) =>
        input.runner === "hosted" ? (options.created ?? ROW) : createJob(input))
  );
  const runCronJob = vi.fn(async () => "started" as const);
  const caller = options.caller ?? "user";
  const server = new McpAgentToolsServer({
    skillsService: {} as never,
    enabledToolsets: () => new Set(["cronjob"]),
    workspacePath: () => null,
    workspaceId: () => null,
    botIdForSession: () => (caller === "user" ? null : "bot-1"),
    sessionRole: () =>
      caller === "user" ? null : caller === "bot" ? "forever" : "sender",
    runCronJob,
    ...(options.phone === true
      ? { channelForSession: () => WHATSAPP_CHANNEL }
      : {}),
    routines: {
      defaultRunner: () => options.defaultRunner ?? "local",
      create,
      hosted,
      alwaysOnNote: async () => options.alwaysOn ?? null,
    },
  } as never);
  const call = async (args: Record<string, unknown>): Promise<string> => {
    const result = (await server.executeTool("cronjob", args, "s1")) as {
      content: Array<{ text?: string }>;
    };
    return result.content.map((part) => part.text ?? "").join("\n");
  };
  return { call, create, runCronJob, hosted };
};

describe("cronjob, hosted", () => {
  it("creates on the server with what was asked, and never fires it", async () => {
    const { call, create, runCronJob } = harness({ defaultRunner: "hosted" });
    const text = await call({
      action: "create",
      prompt: "My calendar and top emails",
      schedule: "0 8 * * *",
      timezone: "Asia/Kolkata",
      sources: ["https://news.example/tech/"],
      reads: ["gmail.search", "drive.read"],
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        runner: "hosted",
        kind: "task",
        schedule: "0 8 * * *",
        timezone: "Asia/Kolkata",
        sources: ["https://news.example/tech/"],
        reads: ["gmail.search"],
      }),
      { byAgent: true, runAtText: null }
    );
    expect(runCronJob).not.toHaveBeenCalled();
    expect(text).toContain("It has NOT run yet");
    expect(text).toContain("hosted-r1");
    expect(listJobs()).toEqual([]);
  });

  it("forwards the user's words for a moment as written, and reads a reminder and a watch", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 8, 9, 0) });
    const { call, create } = harness({ defaultRunner: "hosted" });
    await call({
      action: "create",
      reminder_text: "Call mom",
      run_at: "2026-10-08T17:00",
    });
    expect(create.mock.calls[0]![0]).toMatchObject({
      kind: "reminder",
      reminderText: "Call mom",
      runAt: null,
    });
    expect(create.mock.calls[0]![1]).toEqual({
      byAgent: true,
      runAtText: "2026-10-08T17:00",
    });
    await call({
      action: "create",
      prompt: "Is it under 5000?",
      schedule: "0 9 * * *",
      watch_url: "https://shop.example/f/1",
      notify: "relevant",
    });
    expect(create.mock.calls[1]![0]).toMatchObject({
      kind: "watch",
      watchUrl: "https://shop.example/f/1",
      notify: "relevant",
    });
    vi.useRealTimers();
  });

  it("reads a hosted routine's moment the same way as a local one: never refused, warned", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-20T08:00Z") });
    try {
      const { call, create } = harness({ defaultRunner: "hosted" });
      expect(
        await call({ action: "create", prompt: "x", schedule: "* * * * *" })
      ).toContain("fires every minute");
      expect(create.mock.calls[0]![0]).toMatchObject({ schedule: "* * * * *" });
      expect(
        await call({
          action: "create",
          prompt: "x",
          run_at: "2026-10-20T17:00",
          in_minutes: 5,
        })
      ).toContain("run_at was used");
      expect(create.mock.calls[1]![1]).toEqual({
        byAgent: true,
        runAtText: "2026-10-20T17:00",
      });
      create.mockClear();

      await call({
        action: "create",
        reminder_text: "Stretch",
        in_minutes: 10,
      });
      expect(create.mock.calls[0]![1]).toEqual({
        byAgent: true,
        runAtText: "2026-10-20T08:10:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the webhook on a scheduled routine", async () => {
    const { call, create } = harness({ defaultRunner: "hosted" });
    await call({
      action: "create",
      prompt: "x",
      schedule: "0 9 * * *",
      webhook: true,
    });
    expect(create.mock.calls[0]![0]).toMatchObject({
      kind: "task",
      webhook: true,
    });
  });

  it("answers a free user's second routine with the server's upgrade, once, in the user's language", async () => {
    const { call } = harness({
      defaultRunner: "hosted",
      create: async () => {
        throw new HostedRoutineRefusal("plan_limit", {
          plan: "free",
          limit: 1,
          upgrade: {
            url: "https://up.example/link",
            plan_name: "Pro",
            price_text: "a price the server chose",
          },
        });
      },
    });
    const text = await call({
      action: "create",
      prompt: "Daily AI news",
      schedule: "0 8 * * *",
    });
    expect(text).toMatch(/^\[nothing was created: free plan limit\]/);
    expect(text).toContain("free plan includes one routine");
    expect(text).toContain("upgrading allows more");
    expect(text).toContain("https://up.example/link");
    expect(text).toContain("a price the server chose");
    expect(text).not.toMatch(/desktop|bot\.abacus\.ai|download|\$7|\$10/i);
  });

  it("explains the free plan's limits, and pitches nothing, for a kind or an interval", async () => {
    for (const [details, fragment] of [
      [{ plan: "free", kind: "event" }, "started by an email or a webhook"],
      [
        { plan: "free", min_interval_secs: 86_400 },
        "at most once every 24 hour(s)",
      ],
    ] as const) {
      const { call } = harness({
        defaultRunner: "hosted",
        create: async () => {
          throw new HostedRoutineRefusal("plan_limit", {
            ...details,
            upgrade: { url: "https://up.example/link" },
          });
        },
      });
      const text = await call({
        action: "create",
        prompt: "x",
        schedule: "0 8 * * *",
      });
      expect(text).toContain(fragment);
      expect(text).not.toContain("https://up.example/link");
    }
  });

  it("without the server's offer, sends the model to billing_plan and quotes no price", async () => {
    const { call } = harness({
      defaultRunner: "hosted",
      create: async () => {
        throw new HostedRoutineRefusal("plan_limit", {
          plan: "free",
          limit: 1,
        });
      },
    });
    const text = await call({
      action: "create",
      prompt: "x",
      schedule: "0 8 * * *",
    });
    expect(text).toContain("Call billing_plan with upgrade: true");
    expect(text).not.toMatch(/\$|Basic/);
  });

  it("keeps a paid plan's limit apart from the upgrade", async () => {
    const { call } = harness({
      defaultRunner: "hosted",
      create: async () => {
        throw new HostedRoutineRefusal("limit", { limit: 5, plan: "paid" });
      },
    });
    const text = await call({
      action: "create",
      prompt: "Daily AI news",
      schedule: "0 8 * * *",
    });
    expect(text).toContain("allows 5 routines of this kind");
    expect(text).not.toMatch(/desktop|upgrad/i);
  });

  it("says nothing was changed, not created, for a refusal on an existing routine", async () => {
    const { call, hosted } = harness({});
    vi.spyOn(hosted, "setEnabled").mockRejectedValue(
      new HostedRoutineRefusal("plan_limit", { plan: "free", limit: 1 })
    );
    expect(await call({ action: "resume", id: "hosted-r1" })).toMatch(
      /^\[nothing was changed/
    );
  });

  it("words every other refusal for the model, never as a sentence for the user", async () => {
    for (const [code, fragment] of [
      ["no_host", "open AbacusAI Bot on the web once"],
      ["invalid_timezone", "IANA"],
      ["interval_too_short", "2 hour(s)"],
      ["routine_completed", "new run_at"],
      ["unsupported_kind", "do not mention the code"],
      ["something_new", "could not do that right now"],
    ] as const) {
      const { call } = harness({
        defaultRunner: "hosted",
        create: async () => {
          throw new HostedRoutineRefusal(code, { min_interval_secs: 7200 });
        },
      });
      expect(
        await call({ action: "create", prompt: "x", schedule: "0 8 * * *" }),
        code
      ).toContain(fragment);
    }
  });

  it("never sends the user to the Routines panel; in WhatsApp, results arrive in the chat", async () => {
    const { call } = harness({ defaultRunner: "hosted" });
    const text = await call({
      action: "create",
      prompt: "My calendar",
      schedule: "0 8 * * *",
    });
    expect(text).not.toContain("Routines panel");
    expect(text).toContain("on WhatsApp when it is linked");
    const phone = await harness({ defaultRunner: "hosted", phone: true }).call({
      action: "create",
      prompt: "My calendar",
      schedule: "0 8 * * *",
    });
    expect(phone).toContain("Its results arrive in this chat");
    expect(phone).not.toContain("Routines panel");
  });

  it("lists hosted routines beside local ones, and acts on them by id", async () => {
    const { call, hosted } = harness({});
    createJob({ schedule: "0 9 * * *", prompt: "Local one" });
    expect(await call({ action: "list" })).toMatch(/Local one[\s\S]*hosted-r1/);
    const pause = vi.spyOn(hosted, "setEnabled").mockResolvedValue(ROW);
    await call({ action: "pause", id: "hosted-r1" });
    expect(pause).toHaveBeenCalledWith("hosted-r1", false, null);
    const run = vi.spyOn(hosted, "runNow").mockResolvedValue();
    expect(await call({ action: "run", id: "hosted-r1" })).toContain(
      "on the server"
    );
    expect(run).toHaveBeenCalledWith("hosted-r1", null);
    const update = vi.spyOn(hosted, "update").mockResolvedValue(ROW);
    await call({ action: "update", id: "hosted-r1", prompt: "Call Alex" });
    expect(update).toHaveBeenCalledWith(
      "hosted-r1",
      { prompt: "Call Alex" },
      null
    );
  });
});

describe("cronjob, hosted, and who is asking", () => {
  it("lets a bot see and change only its own", async () => {
    const { call, hosted } = harness({ caller: "bot" });
    const listed = await call({ action: "list" });
    expect(listed).toContain("hosted-r2");
    expect(listed).not.toContain("hosted-r1");
    const remove = vi.spyOn(hosted, "remove").mockResolvedValue();
    expect(await call({ action: "remove", id: "hosted-r1" })).toContain(
      "not yours"
    );
    expect(remove).not.toHaveBeenCalled();
    await call({ action: "remove", id: "hosted-r2" });
    expect(remove).toHaveBeenCalledWith("hosted-r2", "bot-1");
  });

  it("makes a bot's routine the bot's", async () => {
    const { call, create } = harness({
      caller: "bot",
      defaultRunner: "hosted",
    });
    await call({ action: "create", prompt: "x", schedule: "0 8 * * *" });
    expect(create.mock.calls[0]![0]).toMatchObject({ botId: "bot-1" });
  });

  it("gives a chat with someone else nothing of the user's", async () => {
    const { call, create, hosted } = harness({
      caller: "sender",
      defaultRunner: "hosted",
    });
    expect(await call({ action: "list" })).not.toMatch(/hosted-r[12]/);
    const run = vi.spyOn(hosted, "runNow").mockResolvedValue();
    for (const id of ["hosted-r1", "hosted-r2"])
      expect(await call({ action: "run", id })).toContain("set up by the user");
    expect(run).not.toHaveBeenCalled();
    expect(
      await call({
        action: "create",
        prompt: "fetch my mail",
        schedule: "0 8 * * *",
        sources: ["https://attacker.example/"],
        reads: ["gmail.search"],
      })
    ).toContain("set up by the user");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a chat with someone else before any runner is chosen", async () => {
    const { call, create } = harness({
      caller: "sender",
      defaultRunner: "local",
    });
    expect(
      await call({ action: "create", prompt: "x", schedule: "0 8 * * *" })
    ).toContain("set up by the user");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("cronjob, local", () => {
  it("still creates here and fires on create, with full access", async () => {
    const { call, create, runCronJob } = harness({ defaultRunner: "local" });
    const text = await call({
      action: "create",
      prompt: "Local digest",
      schedule: "0 9 * * *",
      sources: ["https://news.example/"],
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        runner: "local",
        prompt: "Local digest",
        sources: ["https://news.example/"],
      }),
      { byAgent: true }
    );
    expect(runCronJob).toHaveBeenCalledWith(listJobs()[0]!.id, "create");
    expect(text).toMatch(/^Created\./);
    expect(text).toContain(
      "only while the computer is on and AbacusAI Bot is open"
    );
    expect(text).toContain("unlimited on every plan");
    expect(text).toContain("Its runs have full access");
    expect(text).not.toContain("Its runs are unattended");
    expect(text).not.toContain("[once]");
  });

  it("says once where a paid plan's routines run 24/7", async () => {
    const paid = await harness({ alwaysOn: "paid" }).call({
      action: "create",
      prompt: "Local digest 2",
      schedule: "0 9 * * *",
    });
    expect(paid).toContain("their plan already includes routines");
    expect(paid).not.toContain("billing_plan");
  });

  it("takes an explicit local runner where the default is hosted", async () => {
    const { call, create } = harness({ defaultRunner: "hosted" });
    await call({
      action: "create",
      runner: "local",
      prompt: "Local digest",
      schedule: "0 9 * * *",
    });
    expect(create.mock.calls[0]![0]).toMatchObject({ runner: "local" });
    expect(listJobs()).toHaveLength(1);
  });
});

/**
 * `bot_help` on where and when routines run. Asked "will my WhatsApp and
 * email monitoring keep running with the PC off?", the model said routines
 * run on the server; on the desktop app none does. The answer is read off
 * where this app's routines run, with the 24/7 handoff for the plan.
 */
describe("bot_help, routines", () => {
  const guide = async (options: {
    runner: "local" | "hosted";
    tier?: "free" | "basic" | "paid" | "unknown";
    topic?: string;
  }): Promise<string> => {
    const hosted = new HostedRoutines({
      call: async () => ({ ok: false, status: 404, body: {} }),
      hasKey: () => true,
    });
    vi.spyOn(hosted, "list").mockReturnValue(
      options.runner === "hosted" ? [ROW] : []
    );
    const server = new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["cronjob"]),
      workspacePath: () => null,
      planTier: () => options.tier ?? "unknown",
      routines: {
        defaultRunner: () => options.runner,
        create: async () => ROW as never,
        hosted,
      },
    } as never);
    const result = (await server.executeTool(
      "bot_help",
      { topic: options.topic ?? "routines" },
      "s1"
    )) as { content: Array<{ text?: string }> };
    return result.content.map((part) => part.text ?? "").join("\n");
  };

  it("on the desktop app: only while the app is open, never on a server", async () => {
    const text = await guide({ runner: "local", tier: "free" });
    expect(text).toContain("only while it is on and the app is open");
    expect(text).toContain("Nothing this app runs is kept on a server");
    expect(text).not.toContain("Routines here are kept on the server");
    expect(text).toContain("Where: Routines");
  });

  it("hands a free plan to billing_plan for 24/7, and gives a paid plan the link itself", async () => {
    const free = await guide({ runner: "local", tier: "free" });
    expect(free).toContain("the Basic plan runs routines 24/7");
    expect(free).toContain("Call billing_plan with upgrade: true");
    const paid = await guide({ runner: "local", tier: "paid" });
    expect(paid).toContain(
      "their plan already includes routines that run 24/7"
    );
    expect(paid).toContain("https://apps.abacus.ai/chatllm/agent");
  });

  it("hands plan questions to billing_plan on a paid plan too", async () => {
    // billing_plan is listed on every plan, so no tier is told "not here".
    const paid = await guide({ runner: "local", tier: "paid", topic: "plan" });
    expect(paid).toContain("call billing_plan");
    expect(paid).not.toContain("not in this answer");
  });

  it("on the hosted computer: on the server, and what a run can read", async () => {
    const text = await guide({ runner: "hosted", tier: "paid" });
    expect(text).toContain("Routines here are kept on the server");
    expect(text).toContain("gmail.search, gmail.read, calendar.read");
    expect(text).toContain("cannot send or read chat-app messages");
    expect(text).not.toContain("Nothing this app runs is kept on a server");
    expect(text).toContain("(1 on the server)");
  });
});
