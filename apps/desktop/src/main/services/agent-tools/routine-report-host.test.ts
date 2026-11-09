import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJob, getJob } from "./cron-store";
import { RoutineReportDelivery } from "./routine-report-delivery";
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
  vi.stubEnv("ABACUSAI_BOT_ROUTINE_DELIVERY", "on");
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const proto = ServiceHost.prototype as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

/**
 * The host's routine-report path on real stores (routines, bots, the send
 * ledger and the outbox), with the chat apps and the sessions table faked at
 * their edges. `settle` files one run that said `reply`.
 */
const harness = (options: {
  whatsapp?: "up" | "down" | "none";
  quiet?: boolean;
}) => {
  const lane = { state: options.whatsapp ?? "up" };
  const sent: Array<{ platform: string; to: string; text: string }> = [];
  const stamped = new Map<string, { to: string; text: string }>();
  const sessions = new Map<
    string,
    { id: string; routineId?: string; createdAt: string; workspaceId: string }
  >();
  const ledger = new RoutineSendLedger({ file: null });
  const service: Record<string, unknown> = {
    routineSends: ledger,
    routineFires: new Map<string, string>(),
    routineRunText: new Map<string, string[]>(),
    routineRunLast: new Map<string, { id: string; text: string }>(),
    routineNetworkWaits: { forget: () => undefined },
    routineHome: () => path.join(home, "routine"),
    emitEvent: () => undefined,
    pauseIfQuietRepeatedly: () => undefined,
    isUnattendedSession: () => false,
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
      setRunReport: (id: string, report: { to: string; text: string }) =>
        stamped.set(id, report),
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
      runningPlatforms: () => (lane.state === "none" ? [] : ["whatsapp"]),
      livePlatforms: () => (lane.state === "up" ? ["whatsapp"] : []),
      selfChats: () => [{ platform: "whatsapp", chatId: "self@c.us" }],
      sendToChat: async (platform: string, to: string, text: string) => {
        if (lane.state !== "up") throw new Error("WhatsApp is not connected");
        sent.push({ platform, to, text });
      },
    },
  };
  for (const name of [
    "deliverRunReport",
    "reportChatOf",
    "reportLanesOf",
    "ownChat",
    "sendToOwnChat",
    "routineReportNotes",
    "quietHoursNow",
    "withRoutineReportNotes",
    "routineDeliversToSelf",
  ])
    service[name] = proto[name];
  service.routineReports = new RoutineReportDelivery({
    ledger,
    file: null,
    send: (laneId, text) =>
      (
        service.messagingGatewayService as {
          sendToChat: (p: string, t: string, x: string) => Promise<void>;
        }
      ).sendToChat(laneId, "me", text),
    liveLanes: () => (lane.state === "up" ? ["whatsapp"] : []),
    quiet: () => options.quiet === true,
    selfChatId: () => "self@c.us",
  });
  const homeBot = createBot({ name: "Planner", description: "Plans my week" });
  let count = 0;
  const settle = async (
    routineId: string,
    reply: string,
    fire = `${routineId}@${++count}`
  ): Promise<string> => {
    const sessionId = `run-${++count}`;
    sessions.set(sessionId, {
      id: sessionId,
      routineId,
      createdAt: new Date().toISOString(),
      workspaceId: "w",
    });
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
    // Delivery runs after the run is filed, without holding the turn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return sessionId;
  };
  const nextMessage = (sessionId: string, message: string) =>
    proto.withRoutineReportNotes!.call(service, {
      workspaceId: "w",
      sessionId,
      message,
    }) as { message: string; userText?: { systemReminder?: true } };
  return {
    service,
    homeBot,
    sent,
    stamped,
    sessions,
    ledger,
    lane,
    settle,
    nextMessage,
  };
};

describe("a bot's check-in run", () => {
  it("reaches the bot's chat word for word and the user's WhatsApp once, and their next message there carries it", async () => {
    const h = harness({});
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const reply =
      "Two drafts are ready for the landlord. Say go and I'll send them.";
    const run = await h.settle(job.id, reply, `${job.id}@900`);

    // The final answer only, not the narration before it.
    expect(h.stamped.get(run)).toMatchObject({
      to: `chat-of-${h.homeBot.id}`,
      text: reply,
    });
    expect(h.sent).toEqual([{ platform: "whatsapp", to: "me", text: reply }]);

    // A make-up of the same fire sends nothing again.
    await h.settle(job.id, reply, `${job.id}@900`);
    expect(h.sent).toHaveLength(1);

    const answer = h.nextMessage(`chat-of-${h.homeBot.id}`, "go");
    expect(answer.message).toMatch(
      /^<system_reminder>\n\[routine report sent\]/
    );
    expect(answer.message).toContain(JSON.stringify(reply));
    expect(answer.message.endsWith("go")).toBe(true);
    expect(answer.userText?.systemReminder).toBe(true);
    // Once: the next message is the user's alone.
    expect(h.nextMessage(`chat-of-${h.homeBot.id}`, "thanks").message).toBe(
      "thanks"
    );
  });

  it("delivers nothing for a NO_REPLY run", async () => {
    const h = harness({});
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const run = await h.settle(job.id, "Nothing new.\nNO_REPLY");
    expect(h.stamped.has(run)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.nextMessage(`chat-of-${h.homeBot.id}`, "hi").message).toBe("hi");
  });

  it("waits out quiet hours on WhatsApp, and still lands in the app's chat", async () => {
    const h = harness({ quiet: true });
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const run = await h.settle(job.id, "Your rent is due Friday.");
    expect(h.stamped.has(run)).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("is held while WhatsApp is down and sent when it is back", async () => {
    const h = harness({ whatsapp: "down" });
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    await h.settle(job.id, "Your rent is due Friday.");
    expect(h.sent).toEqual([]);
    h.lane.state = "up";
    await (h.service.routineReports as RoutineReportDelivery).flush();
    expect(h.sent).toEqual([
      { platform: "whatsapp", to: "me", text: "Your rent is due Friday." },
    ]);
  });

  it("makes the run's own send to the user a skip, not a second message", () => {
    const h = harness({});
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    h.sessions.set("run-x", {
      id: "run-x",
      routineId: job.id,
      createdAt: new Date().toISOString(),
      workspaceId: "w",
    });
    const delivers = (platform: string) =>
      proto.routineDeliversToSelf!.call(h.service, "run-x", platform);
    expect(delivers("whatsapp")).toBe(true);
    expect(delivers("abacus_telegram")).toBe(false);
  });
});

describe("a routine made from a chat", () => {
  it("reports into that chat, with no chat app send", async () => {
    const h = harness({});
    h.sessions.set("origin", {
      id: "origin",
      createdAt: new Date().toISOString(),
      workspaceId: "w",
    });
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "summarize the news",
      originSessionId: "origin",
    });
    expect(getJob(job.id)?.originSessionId).toBe("origin");
    const run = await h.settle(job.id, "Three headlines today.");
    expect(h.stamped.get(run)).toMatchObject({ to: "origin" });
    expect(h.sent).toEqual([]);
    expect(h.nextMessage("origin", "more on the second").message).toContain(
      "[routine report sent]"
    );
  });

  it("is not delivered with the flag off", async () => {
    vi.stubEnv("ABACUSAI_BOT_ROUTINE_DELIVERY", "off");
    const h = harness({});
    const job = createJob({
      schedule: "0 9 * * *",
      prompt: "check in",
      botId: h.homeBot.id,
    });
    const run = await h.settle(job.id, "Your rent is due Friday.");
    expect(h.stamped.has(run)).toBe(false);
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
    expect(text.endsWith("go")).toBe(true);
    expect(
      visibleUserText(text, noted!.metadata.abacus.userText as never)
    ).toBe("go");
    expect(messages[1]).toMatchObject({ parts: [{ content: "go" }] });
  });
});
