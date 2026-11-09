/**
 * The host's routine-report path on real stores (routines, bots, the send
 * ledger, the report store on a real file), with the gateway and the
 * sessions table faked at their edges.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJob, getJob } from "./cron-store";
import { RoutineReportStore } from "./routine-report-delivery";
import { RoutineSendLedger } from "./routine-send-ledger";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    { default: anything },
    {
      get: (target, property) =>
        property in target
          ? (target as Record<PropertyKey, unknown>)[property]
          : property === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});
const { ServiceHost } = await import("../../service-host");
const { createBot } = await import("../bots/bot-store");

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "routine-reports-"));
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const proto = ServiceHost.prototype as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

type Owed = {
  lane: string;
  id: string;
  text: string;
  notBefore?: number;
  expiresAt?: number;
  replaces?: string;
};
type Session = {
  id: string;
  routineId?: string;
  createdAt: string;
  workspaceId: string;
  editorFor?: string | null;
  owner?: unknown;
  report?: { to: string; text: string };
};

const harness = (options: { quiet?: boolean; platform?: string } = {}) => {
  const owed: Owed[] = [];
  const sessions = new Map<string, Session>();
  const sent: Array<{ sessionId: string; message: string }> = [];
  const created: string[] = [];
  const reportsFile = path.join(home, "routine-reports.json");
  const service: Record<string, unknown> = {
    platform: options.platform ?? "electron",
    routineSends: new RoutineSendLedger({ file: null }),
    routineReports: new RoutineReportStore({ file: () => reportsFile }),
    routineFires: new Map<string, string>(),
    routineRunText: new Map<string, string[]>(),
    routineRunLast: new Map<string, { id: string; text: string }>(),
    routineNetworkWaits: { forget: () => undefined },
    routineHome: () => path.join(home, "routine"),
    emitEvent: () => undefined,
    pauseIfQuietRepeatedly: () => undefined,
    isUnattendedSession: () => false,
    appLanguage: () => "en-US",
    listRoutineRuns: (routineId: string) =>
      [...sessions.values()]
        .filter((session) => session.routineId === routineId)
        .map((session) => ({
          sessionId: session.id,
          startedAt: session.createdAt,
        })),
    threadStore: {
      readCurrentFile: () => ({
        messages: [
          { role: "assistant", parts: [{ type: "text", content: "Looking." }] },
          {
            role: "assistant",
            parts: [{ type: "text", content: "Want the second story?" }],
          },
        ],
      }),
    },
    routineProject: () => null,
    ensureSessionHomeWorkspace: async () => "auto",
    createAgentSession: (workspaceId: string) => {
      const id = `new-${created.length + 1}`;
      created.push(id);
      sessions.set(id, {
        id,
        createdAt: new Date().toISOString(),
        workspaceId,
      });
      return { id };
    },
    updateAgentSessionLabel: () => true,
    startAgentSession: async () => ({ success: true }),
    sendAgentMessage: async (request: {
      sessionId: string;
      message: string;
    }) => {
      sent.push(request);
      return true;
    },
    prefs: () => ({
      get: () => ({
        sounds: {
          quietHours: {
            enabled: options.quiet === true,
            start: "00:00",
            end: "23:59",
          },
        },
      }),
    }),
    agentSessionManagerService: {
      isRoutineSession: (id: string) => sessions.get(id)?.routineId != null,
      setRunOutcome: () => true,
      get: (id: string) => sessions.get(id) ?? null,
      setRunReport: (id: string, report: { to: string; text: string }) => {
        const session = sessions.get(id);
        if (session != null) session.report = report;
        return true;
      },
    },
    botService: {
      openChat: async (botId: string) => ({
        botId,
        workspaceId: "w",
        sessionId: `chat-of-${botId}`,
      }),
      homeBotId: () => homeBot.id,
    },
    messagingGatewayService: {
      runningPlatforms: () => ["whatsapp"],
      isOwnChat: (_platform: string, to: string) => to === "me",
      sendToOwnChat: async (lane: string, message: Omit<Owed, "lane">) => {
        owed.push({ lane, ...message });
        return "sent";
      },
    },
  };
  for (const name of [
    "deliversRoutineReports",
    "deliverRunReport",
    "makeRunReport",
    "reportTargets",
    "replayRunReports",
    "channelWordsNow",
    "reportChatOf",
    "reportLanesOf",
    "routineReportNotes",
    "routineDeliversToSelf",
    "routineOrigin",
    "replyChatOf",
    "lastAssistantText",
  ])
    service[name] = proto[name];
  const homeBot = createBot({ name: "Planner", description: "Plans my week" });
  let count = 0;
  const run = (routineId: string) => {
    const sessionId = `run-${++count}`;
    sessions.set(sessionId, {
      id: sessionId,
      routineId,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      workspaceId: "w",
    });
    return sessionId;
  };
  const settle = async (
    routineId: string,
    reply: string,
    fire = `${routineId}@${++count}`
  ) => {
    const sessionId = run(routineId);
    (service.routineFires as Map<string, string>).set(sessionId, fire);
    (service.routineRunText as Map<string, string[]>).set(sessionId, [
      "Looking at your tasks. ",
      reply,
    ]);
    (service.routineRunLast as Map<string, { id: string; text: string }>).set(
      sessionId,
      { id: "m2", text: reply }
    );
    proto.settleRoutineRun!.call(service, {
      turnId: sessionId,
      sessionId,
      kind: "reply",
      startedAt: count,
      endedAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    return sessionId;
  };
  const notes = (sessionId: string) =>
    proto.routineReportNotes!.call(service, sessionId, undefined) as {
      notes: string[];
      taken: () => void;
    };
  return {
    service,
    homeBot,
    owed,
    sessions,
    sent,
    created,
    reportsFile,
    run,
    settle,
    notes,
  };
};

describe("a bot's check-in run", () => {
  it("reaches the bot's chat word for word and the user's own chat once, and their next message there carries it", async () => {
    const h = harness();
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const reply =
      "Two drafts for the landlord are ready. Say go and I'll send them.";
    const first = await h.settle(job.id, reply, `${job.id}@900`);

    expect(h.sessions.get(first)?.report).toMatchObject({
      to: `chat-of-${h.homeBot.id}`,
      text: reply,
    });
    expect(h.owed).toEqual([
      expect.objectContaining({
        lane: "whatsapp",
        id: `routine-report:${job.id}@900:whatsapp`,
        replaces: `routine-report:${job.id}:whatsapp`,
      }),
    ]);
    expect(h.owed[0]!.text.startsWith(reply)).toBe(true);
    expect(h.owed[0]!.text).toContain("Routines → check in");
    expect(h.owed[0]!.notBefore).toBeUndefined();
    expect(h.owed[0]!.expiresAt).toBeGreaterThan(Date.now() + 11 * 60 * 60_000);

    // A make-up of the same fire delivers nothing again.
    await h.settle(job.id, reply, `${job.id}@900`);
    expect(h.owed).toHaveLength(1);

    const owedNotes = h.notes(`chat-of-${h.homeBot.id}`);
    expect(owedNotes.notes).toHaveLength(1);
    expect(owedNotes.notes[0]).toContain(JSON.stringify(reply));
    owedNotes.taken();
    expect(h.notes(`chat-of-${h.homeBot.id}`).notes).toEqual([]);
  });

  it("delivers nothing for a NO_REPLY run", async () => {
    const h = harness();
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const run = await h.settle(job.id, "Nothing new.\nNO_REPLY");
    expect(h.sessions.get(run)?.report).toBeUndefined();
    expect(h.owed).toEqual([]);
  });

  it("holds the chat-app send until quiet hours end, and still lands in the app's chat", async () => {
    const h = harness({ quiet: true });
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const run = await h.settle(job.id, "Your rent is due Friday.");
    expect(h.sessions.get(run)?.report).toBeDefined();
    expect(h.owed[0]!.notBefore).toBeGreaterThan(Date.now());
  });

  it("is made after a restart when the app closed between recording and making it", async () => {
    const h = harness();
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const runId = h.run(job.id);
    new RoutineReportStore({ file: () => h.reportsFile }).begin({
      fire: `${job.id}@5`,
      routineId: job.id,
      routineName: job.name,
      runSessionId: runId,
      startedAt: new Date().toISOString(),
      text: "Your rent is due Friday.",
      runFile: null,
    });
    await proto.replayRunReports!.call(h.service);
    expect(h.sessions.get(runId)?.report?.text).toBe(
      "Your rent is due Friday."
    );
    expect(h.owed).toHaveLength(1);
    expect(
      new RoutineReportStore({ file: () => h.reportsFile }).unfinished()
    ).toEqual([]);
  });

  it("makes the run's own text send to the user a skip, not a second message", () => {
    const h = harness();
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const runId = h.run(job.id);
    const delivers = (platform: string) =>
      proto.routineDeliversToSelf!.call(h.service, runId, platform);
    expect(delivers("whatsapp")).toBe(true);
    expect(delivers("abacus_telegram")).toBe(false);
  });

  it("is not delivered by the hosted computer, whose server delivers it", async () => {
    const h = harness({ platform: "web-host" });
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const run = await h.settle(job.id, "Your rent is due Friday.");
    expect(h.sessions.get(run)?.report).toBeUndefined();
    expect(h.owed).toEqual([]);
  });
});

describe("a routine made from a chat", () => {
  it("is stamped with that chat when the user is in it, and reports there with no chat-app send", async () => {
    const h = harness();
    h.sessions.set("origin", {
      id: "origin",
      createdAt: new Date().toISOString(),
      workspaceId: "w",
    });
    h.sessions.set("bot-chat", {
      id: "bot-chat",
      createdAt: "",
      workspaceId: "w",
      owner: { kind: "bot" },
    });
    h.sessions.set("editor", {
      id: "editor",
      createdAt: "",
      workspaceId: "w",
      editorFor: "job-x",
    });
    const origin = (id: string) => proto.routineOrigin!.call(h.service, id);
    expect(origin("origin")).toBe("origin");
    expect(origin("bot-chat")).toBeNull();
    expect(origin("editor")).toBeNull();
    expect(origin("missing")).toBeNull();

    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "news",
      originSessionId: "origin",
    });
    const run = await h.settle(job.id, "Three headlines today.");
    expect(h.sessions.get(run)?.report).toMatchObject({ to: "origin" });
    expect(h.owed).toEqual([]);
  });
});

describe("Reply to this run", () => {
  const reply = (
    h: ReturnType<typeof harness>,
    routineId: string,
    runId: string,
    text: string
  ) =>
    proto.replyToRoutineRun!.call(
      h.service,
      routineId,
      runId,
      text
    ) as Promise<{
      sessionId: string;
      botId: string | null;
    }>;

  it("opens a chat for a routine with none, stamps it, and carries the run's last message, not as delivered", async () => {
    const h = harness();
    const job = createJob({ schedule: "0 9 * * *", prompt: "news" });
    const runId = h.run(job.id);
    const chat = await reply(h, job.id, runId, "more on the second");
    expect(chat).toMatchObject({ sessionId: "new-1", botId: null });
    expect(getJob(job.id)?.originSessionId).toBe("new-1");
    expect(h.sent).toEqual([
      expect.objectContaining({
        sessionId: "new-1",
        message: "more on the second",
      }),
    ]);
    const [note] = h.notes("new-1").notes;
    expect(note).toContain('"Want the second story?"');
    expect(note).not.toContain("Looking.");
    expect(note).toMatch(/^\[routine report\] The user opened this chat/);
    expect(note).toContain(`-${runId}.md`);

    // The same run again: one note, in the same chat.
    await reply(h, job.id, runId, "and the third");
    expect(h.created).toEqual(["new-1"]);
    expect(h.notes("new-1").notes).toHaveLength(1);
  });

  it("goes to the bot's chat for a bot's routine, as delivered when it was", async () => {
    const h = harness();
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const runId = await h.settle(job.id, "Say go?");
    h.notes(`chat-of-${h.homeBot.id}`).taken();
    const chat = await reply(h, job.id, runId, "go");
    expect(chat).toMatchObject({
      sessionId: `chat-of-${h.homeBot.id}`,
      botId: h.homeBot.id,
    });
    expect(h.notes(`chat-of-${h.homeBot.id}`).notes[0]).toMatch(
      /^\[routine report sent\]/
    );
  });

  it("is refused on the hosted computer, and for another routine's run", async () => {
    const job = createJob({ schedule: "0 9 * * *", prompt: "news" });
    const other = createJob({ schedule: "0 9 * * *", prompt: "other" });
    const hosted = harness({ platform: "web-host" });
    await expect(
      reply(hosted, job.id, hosted.run(job.id), "x")
    ).rejects.toThrow(/not available/);
    const h = harness();
    await expect(reply(h, job.id, h.run(other.id), "x")).rejects.toThrow(
      /gone/
    );
    expect(h.sent).toEqual([]);
  });
});

describe("a message typed in the app's chat", () => {
  it("carries the report in front, and the chat still shows only the user's words", async () => {
    const { withUserMessageNotes } = await import("../agui/relay-service");
    const { visibleUserText } = await import("@abacus-ai/agent/user-text");
    const messages = [
      { id: "a", role: "assistant", parts: [{ type: "text", content: "Hi" }] },
      { id: "u", role: "user", parts: [{ type: "text", content: "go" }] },
    ] as unknown as Parameters<typeof withUserMessageNotes>[0];
    const [, noted] = withUserMessageNotes(messages, [
      "[routine report sent] Say go?",
    ]) as unknown as Array<{
      parts: Array<{ content: string }>;
      metadata: { abacus: { userText: { systemReminder?: true } } };
    }>;
    const text = noted!.parts.map((part) => part.content).join("");
    expect(text).toMatch(/^<system_reminder>\n\[routine report sent\]/);
    expect(
      visibleUserText(text, noted!.metadata.abacus.userText as never)
    ).toBe("go");
    expect(messages[1]).toMatchObject({ parts: [{ content: "go" }] });
  });
});

describe("a message to a chat owed a report's note", () => {
  const deliver = (h: ReturnType<typeof harness>, agentTakesIt: boolean) => {
    const written: string[] = [];
    const service = {
      ...h.service,
      moveSessionPinToTier: () => undefined,
      withVaultNotes: async (request: unknown) => request,
      withEnvironmentNotice: async (request: unknown) => request,
      waitOutStoppingAgent: async () => undefined,
      agentManagerService: {
        getSessionState: () => ({
          status: agentTakesIt ? "running" : "stopped",
        }),
      },
      agentCommunicationService: {
        sendMessage: (request: { message: string }) => {
          written.push(request.message);
          return true;
        },
      },
      startAgentSession: async () => ({ success: false }),
    };
    return {
      written,
      send: () =>
        proto.deliverAgentMessage!.call(
          service,
          { workspaceId: "w", sessionId: "chat", message: "go" },
          null,
          () => true
        ) as Promise<{ outcome: string }>,
    };
  };

  it("leaves it owed when no agent took the message, and carries it once one does", async () => {
    const h = harness();
    (h.service.routineReports as RoutineReportStore).addNote(
      "chat",
      {
        routineId: "job-1",
        routineName: "Check-in",
        runSessionId: "run-9",
        startedAt: new Date().toISOString(),
        text: "Say go?",
        runFile: null,
      },
      { delivered: true }
    );

    const refused = deliver(h, false);
    expect((await refused.send()).outcome).toBe("undeliverable");
    expect(h.notes("chat").notes).toHaveLength(1);

    const taken = deliver(h, true);
    expect((await taken.send()).outcome).not.toBe("undeliverable");
    expect(taken.written[0]).toMatch(
      /^<system_reminder>\n\[routine report sent\][\s\S]*go$/
    );
    expect(h.notes("chat").notes).toEqual([]);
  });
});
