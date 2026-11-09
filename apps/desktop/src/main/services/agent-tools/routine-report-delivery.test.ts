import { describe, expect, it } from "vitest";

import {
  carriesUserWords,
  chatAppReportText,
  REPORT_CHAT_APP_MAX_CHARS,
  REPORT_OUTBOX_KEPT_MS,
  RoutineReportDelivery,
  runReportTargets,
  type RunReport,
} from "./routine-report-delivery";
import { RoutineSendLedger } from "./routine-send-ledger";

const SELF = "self-chat-id";

describe("where a run's report goes", () => {
  const base = {
    outcome: "completed" as const,
    reply: "Three replies need your yes. Say go and I'll send them.",
    chat: "bot-chat",
    lanes: [{ lane: "whatsapp" as const, live: true }],
    sent: [],
    selfChatId: () => SELF,
    quiet: false,
  };

  it.each([
    [
      "a bot's run: its chat and its lane",
      base,
      { chat: "bot-chat", send: ["whatsapp"], hold: [] },
    ],
    [
      "a run from a chat with no lane",
      { ...base, chat: "origin", lanes: [] },
      { chat: "origin", send: [], hold: [] },
    ],
    [
      "a run with no chat yet",
      { ...base, chat: null, lanes: [] },
      { chat: null, send: [], hold: [] },
    ],
    [
      "the lane is down: held",
      { ...base, lanes: [{ lane: "whatsapp" as const, live: false }] },
      { chat: "bot-chat", send: [], hold: ["whatsapp"] },
    ],
    [
      "quiet hours: the lane waits, the chat does not",
      { ...base, quiet: true },
      { chat: "bot-chat", send: [], hold: ["whatsapp"] },
    ],
    [
      "the run itself sent to me there",
      { ...base, sent: [{ platform: "whatsapp", to: "me" }] },
      { chat: "bot-chat", send: [], hold: [] },
    ],
    [
      "the run sent to the self chat by id",
      { ...base, sent: [{ platform: "whatsapp", to: SELF }] },
      { chat: "bot-chat", send: [], hold: [] },
    ],
    [
      "the run messaged a contact: still delivered",
      { ...base, sent: [{ platform: "whatsapp", to: "Priya" }] },
      { chat: "bot-chat", send: ["whatsapp"], hold: [] },
    ],
    [
      "the fire's chat delivery already made",
      { ...base, sent: [{ platform: "app", to: "bot-chat" }] },
      { chat: null, send: ["whatsapp"], hold: [] },
    ],
    [
      "a Telegram send reaches the shared bot's lane",
      {
        ...base,
        lanes: [{ lane: "abacus_telegram" as const, live: true }],
        sent: [{ platform: "telegram", to: "me" }],
      },
      { chat: "bot-chat", send: [], hold: [] },
    ],
  ])("%s", (_name, input, expected) => {
    expect(runReportTargets(input)).toEqual(expected);
  });

  it.each([
    ["NO_REPLY", { reply: "Checked the inbox.\nNO_REPLY" }],
    ["nothing said", { reply: "  " }],
    ["a failed run", { outcome: "failed" as const }],
    ["a run the app closed under", { outcome: "interrupted" as const }],
  ])("delivers nothing for %s", (_name, change) => {
    expect(runReportTargets({ ...base, ...change })).toBeNull();
  });
});

describe("a report on a chat app", () => {
  it("goes whole up to the cap, else cut at a word", () => {
    expect(chatAppReportText("  Done.  ")).toBe("Done.");
    const long = `${"word ".repeat(400)}end`;
    const cut = chatAppReportText(long);
    expect(cut.length).toBeLessThanOrEqual(REPORT_CHAT_APP_MAX_CHARS);
    expect(cut.endsWith("word…")).toBe(true);
  });
});

/** A delivery with a real ledger, a clock and a chat app that records what it got. */
const setup = (options: { live?: boolean; quiet?: boolean } = {}) => {
  const clock = { now: 1_000_000 };
  const state = { live: options.live ?? true, quiet: options.quiet ?? false };
  const sends: Array<{ lane: string; text: string }> = [];
  const ledger = new RoutineSendLedger({ now: () => clock.now, file: null });
  const delivery = new RoutineReportDelivery({
    ledger,
    now: () => clock.now,
    file: null,
    liveLanes: () => (state.live ? ["whatsapp"] : []),
    quiet: () => state.quiet,
    selfChatId: () => SELF,
    send: async (lane, text) => {
      if (!state.live) throw new Error("WhatsApp is not connected");
      sends.push({ lane, text });
    },
  });
  const deliver = async (report: RunReport) =>
    delivery.deliver(
      report,
      runReportTargets({
        outcome: "completed",
        reply: report.text,
        chat: "bot-chat",
        lanes: [{ lane: "whatsapp", live: state.live }],
        sent: ledger.recipients(report.fire),
        selfChatId: () => SELF,
        quiet: state.quiet,
      })!
    );
  return { clock, state, sends, ledger, delivery, deliver };
};

const report = (overrides: Partial<RunReport> = {}): RunReport => ({
  fire: "job-1@100",
  routineId: "job-1",
  routineName: "Check-in",
  runSessionId: "run-1",
  startedAt: "2026-11-04T04:01:01.000Z",
  text: "Two drafts are ready. Say go and I'll send them.",
  runFile: "/home/u/.abacusai-bot/routines/job-1/runs/a.md",
  from: { botId: "bot-1", name: "Planner" },
  ...overrides,
});

describe("one fire, one delivery", () => {
  it("a make-up or catch-up of the same fire delivers nothing again", async () => {
    const { sends, ledger, deliver } = setup();
    await deliver(report());
    // The same fire's make-up run, after a restart.
    const again = runReportTargets({
      outcome: "completed",
      reply: "Two drafts are ready.",
      chat: "bot-chat",
      lanes: [{ lane: "whatsapp", live: true }],
      sent: ledger.recipients("job-1@100"),
      selfChatId: () => SELF,
      quiet: false,
    });
    expect(again).toEqual({ chat: null, send: [], hold: [] });
    expect(sends).toHaveLength(1);
    // The next scheduled fire is its own.
    await deliver(report({ fire: "job-1@160", runSessionId: "run-2" }));
    expect(sends).toHaveLength(2);
  });

  it("a run's own send to the user and the app's do not both go", async () => {
    const { sends, ledger, delivery } = setup();
    ledger.record("job-1@100", "whatsapp", "me", "run-1", "sent by the run");
    // Decided before the run's send landed: the send itself still checks.
    await delivery.deliver(report(), {
      chat: null,
      send: ["whatsapp"],
      hold: [],
    });
    expect(sends).toEqual([]);
  });
});

describe("the outbox", () => {
  it("holds a send while the chat app is down and sends it when it is back", async () => {
    const { state, sends, delivery, deliver } = setup({ live: false });
    await deliver(report());
    expect(sends).toEqual([]);
    expect(delivery.held()).toHaveLength(1);
    await delivery.flush();
    expect(sends).toEqual([]);
    state.live = true;
    await delivery.flush();
    expect(sends).toEqual([{ lane: "whatsapp", text: report().text }]);
    expect(delivery.held()).toEqual([]);
    await delivery.flush();
    expect(sends).toHaveLength(1);
  });

  it("holds through quiet hours, then sends", async () => {
    const { state, sends, delivery, deliver } = setup({ quiet: true });
    await deliver(report());
    await delivery.flush();
    expect(sends).toEqual([]);
    state.quiet = false;
    await delivery.flush();
    expect(sends).toHaveLength(1);
  });

  it("drops a held send at the routine's next report", async () => {
    const { state, sends, delivery, deliver } = setup({ live: false });
    await deliver(report({ text: "Old: say go?" }));
    await deliver(
      report({ fire: "job-1@160", runSessionId: "run-2", text: "New." })
    );
    state.live = true;
    await delivery.flush();
    expect(sends.map((sent) => sent.text)).toEqual(["New."]);
  });

  it("drops a held send after 12 hours", async () => {
    const { clock, state, sends, delivery, deliver } = setup({ live: false });
    await deliver(report());
    clock.now += REPORT_OUTBOX_KEPT_MS + 1;
    state.live = true;
    await delivery.flush();
    expect(sends).toEqual([]);
    expect(delivery.held()).toEqual([]);
  });

  it("a send that fails goes back in the outbox", async () => {
    const { state, sends, delivery } = setup({ live: false });
    await delivery.deliver(report(), {
      chat: null,
      send: ["whatsapp"],
      hold: [],
    });
    expect(delivery.held()).toHaveLength(1);
    state.live = true;
    await delivery.flush();
    expect(sends).toHaveLength(1);
  });
});

describe("the note on the user's next message", () => {
  it("is given once, names the run and its report, and shows the newest three", async () => {
    const { delivery, deliver } = setup();
    for (let n = 1; n <= 4; n++)
      await deliver(
        report({
          fire: `job-1@${n}`,
          runSessionId: `run-${n}`,
          text: `Report ${n}`,
        })
      );
    const notes = delivery.takeNotes("bot-chat");
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(
      /^\[routine report sent\] Your routine "Check-in" \(id job-1\)/
    );
    expect(notes[0]).toContain('"Report 2"');
    expect(notes[2]).toContain('"Report 4"');
    expect(notes[2]).toContain("in this chat and WhatsApp");
    expect(notes[2]).toContain("Their message may answer it");
    expect(notes[2]).toContain("runs/a.md");
    expect(delivery.takeNotes("bot-chat")).toEqual([]);
    expect(delivery.takeNotes("another-chat")).toEqual([]);
  });

  it("cuts a long report and drops one older than two days", async () => {
    const { clock, delivery, deliver } = setup();
    await deliver(report({ text: "x".repeat(5_000) }));
    const [note] = delivery.takeNotes("bot-chat");
    expect(note!.length).toBeLessThan(2_200);
    await deliver(report({ fire: "job-1@2" }));
    clock.now += 49 * 60 * 60_000;
    expect(delivery.takeNotes("bot-chat")).toEqual([]);
  });

  it.each([
    ["a typed message", undefined, true],
    [
      "a chat app's message with the rules in front",
      { operator: { kind: "auto-reply-intro" as const, visibleFrom: 40 } },
      true,
    ],
    ["a routine fire", { routineFire: true as const }, false],
    ["the kickstart", { operator: { kind: "kickstart" as const } }, false],
    [
      "the app's own note",
      {
        systemReminder: true as const,
        operator: { kind: "environment-notice" as const },
      },
      false,
    ],
    ["a hidden reminder alone", { systemReminder: true as const }, false],
    [
      "the routine editor",
      { operator: { kind: "routine-editor" as const, visibleFrom: 10 } },
      false,
    ],
  ])("rides on %s: %s", (_name, tags, expected) => {
    expect(carriesUserWords(tags)).toBe(expected);
  });
});
