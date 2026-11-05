/**
 * BotAskService: a request to another bot is recorded and returns at once,
 * runs in the background one at a time per pair of bots, and its outcome
 * reaches the asker as a note; the record survives a restart, a cancel stops
 * the other bot, and the caps hold.
 */
import { describe, expect, it, vi } from "vitest";

import { MAX_REQUESTS_PER_DAY } from "./bot-ask";
import { type BotAskRecord, BotAskService } from "./bot-ask-service";

const BOTS = {
  res: { id: "res", name: "Researcher", title: "Research Scout" },
  wri: { id: "wri", name: "Writer", title: "Content Writer" },
  pla: { id: "pla", name: "Planner", title: "" },
} as const;

/** A turn the test ends by hand. */
type Turn = {
  ask: BotAskRecord;
  prompt: string;
  visibleFrom: number | null;
  answer: (raw: string) => void;
  fail: (message: string) => void;
};

const setup = (stored: BotAskRecord[] = []) => {
  let records = stored;
  let now = 1_000_000;
  let ids = 0;
  const turns: Turn[] = [];
  const notes: Array<{
    session: string;
    channel?: BotAskRecord["channel"];
    note: string;
  }> = [];
  const stopTurn = vi.fn();
  const changed = vi.fn();
  const note = vi.fn();
  const logs: string[] = [];
  const service = new BotAskService({
    bot: (id) =>
      (BOTS as Record<string, { id: string; name: string; title: string }>)[
        id
      ] ?? null,
    runTurn: (ask, prompt, visibleFrom) =>
      new Promise<string>((resolve, reject) => {
        turns.push({
          ask,
          prompt,
          visibleFrom,
          answer: resolve,
          fail: (message) => reject(new Error(message)),
        });
      }),
    stopTurn,
    tell: (ask, note) =>
      notes.push({ session: ask.askerSession, channel: ask.channel, note }),
    read: () => records.map((record) => ({ ...record })),
    write: (next) => {
      records = next;
    },
    now: () => now,
    newId: () => `q${++ids}`,
    changed,
    note,
    ownChatLines: (botId) =>
      botId === "wri"
        ? ["our brand voice is cheeky", "always say pre-order"]
        : [],
    log: (line) => logs.push(line),
  });
  return {
    service,
    turns,
    notes,
    note,
    stopTurn,
    changed,
    logs,
    records: () => records,
    later: (ms: number) => {
      now += ms;
    },
  };
};

/** Lets a finished turn's then/finally run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BotAskService", () => {
  it("records the request and returns at once, before any answer", () => {
    const { service, turns, records } = setup();
    const started = service.ask("res", "res-chat", "wri", "Draft a post");
    expect(started).toMatchObject({ ask: { id: "q1" }, behind: 0 });
    expect(records()[0]).toMatchObject({ status: "running", attempts: 1 });
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toContain("It is NOT the user");
    expect(turns[0].prompt).toContain(
      "[from bot Researcher (Research Scout)] Draft a post"
    );
  });

  it("gives the asked bot what the user told it in its own chat, as context", () => {
    const { service, turns } = setup();
    service.ask("res", "res-chat", "wri", "Draft a tagline");
    service.ask("res", "res-chat", "pla", "Plan the week");
    expect(turns[0].prompt).toContain(
      "What the user told you recently in your own chat"
    );
    expect(turns[0].prompt).toContain("- always say pre-order");
    // The request still comes last, after the context.
    expect(turns[0].prompt.trimEnd().endsWith("Draft a tagline")).toBe(true);
    expect(turns[1].prompt).not.toContain("What the user told you recently");
  });

  it("logs each request's steps without its text", async () => {
    const { service, turns, logs } = setup();
    service.ask("res", "res-chat", "wri", "a secret plan");
    turns[0].answer("<reply>ok</reply>");
    await settle();
    expect(logs).toEqual([
      "[bot-ask] q1 ask res->wri queued 0s attempt 0",
      "[bot-ask] q1 ask res->wri running 0s attempt 1",
      "[bot-ask] q1 ask res->wri answered 0s attempt 1",
    ]);
    expect(logs.join(" ")).not.toContain("secret");
  });

  it("says a request was made, so the asker's follow-up tools appear", () => {
    const { service, changed } = setup();
    service.ask("res", "res-chat", "wri", "Draft");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("tells the asker's chat the answer as a note when it lands", async () => {
    const { service, turns, notes, records } = setup();
    service.ask("res", "res-chat", "wri", "Draft a post");
    turns[0].answer("thinking<reply>The draft.</reply>");
    await settle();
    expect(records()[0]).toMatchObject({
      status: "answered",
      answer: "The draft.",
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].session).toBe("res-chat");
    expect(notes[0].note).toMatch(/^\[bot answer\] Writer answered/);
    expect(notes[0].note).toContain("The draft.");
    expect(notes[0].note).not.toContain("thinking");
  });

  it("sends the answer back to the user's own chat the request came from", async () => {
    const { service, turns, notes, records } = setup();
    service.ask("res", "res-chat", "wri", "Draft", {
      channel: { platform: "whatsapp", chatId: "me" },
    });
    expect(records()[0].channel).toEqual({
      platform: "whatsapp",
      chatId: "me",
    });
    turns[0].answer("<reply>The draft.</reply>");
    await settle();
    expect(notes[0].channel).toEqual({ platform: "whatsapp", chatId: "me" });
  });

  it("tells the asker why when the other bot fails", async () => {
    const { service, turns, notes, records } = setup();
    service.ask("res", "res-chat", "wri", "Draft");
    turns[0].fail("it took more than 10 minutes, so it was stopped.");
    await settle();
    expect(records()[0].status).toBe("failed");
    expect(notes[0].note).toContain("Writer could not answer");
    expect(notes[0].note).toContain("so it was stopped");
  });

  it("runs requests between the same two bots one at a time, in order", async () => {
    const { service, turns, notes } = setup();
    service.ask("res", "res-chat", "wri", "first");
    const second = service.ask("res", "res-chat", "wri", "second");
    expect(second).toMatchObject({ behind: 1 });
    expect(turns).toHaveLength(1);
    turns[0].answer("<reply>one</reply>");
    await settle();
    expect(turns).toHaveLength(2);
    expect(turns[1].prompt).toContain("second");
    turns[1].answer("<reply>two</reply>");
    await settle();
    expect(notes.map((each) => each.note)).toEqual([
      expect.stringContaining("one"),
      expect.stringContaining("two"),
    ]);
  });

  it("runs requests to different bots side by side", () => {
    const { service, turns } = setup();
    service.ask("res", "res-chat", "wri", "draft");
    service.ask("res", "res-chat", "pla", "plan");
    expect(turns.map((turn) => turn.ask.targetId)).toEqual(["wri", "pla"]);
  });

  it("takes as many requests as the user asks for, queued per conversation", () => {
    const { service, turns } = setup();
    for (let i = 0; i < 5; i++)
      expect(service.ask("res", "res-chat", "wri", `thing ${i}`)).toMatchObject(
        {
          behind: i,
        }
      );
    expect(turns).toHaveLength(1);
  });

  it("refuses the same request to the same bot while it is still open", () => {
    const { service } = setup();
    service.ask("res", "res-chat", "wri", "Draft a tagline");
    expect(service.ask("res", "res-chat", "wri", "  draft a TAGLINE ")).toEqual(
      {
        error: expect.stringContaining("You already sent that (request q1)"),
      }
    );
    // Another bot, or a task rather than a question, is a different request.
    expect(
      service.ask("res", "res-chat", "pla", "Draft a tagline")
    ).toMatchObject({
      ask: { id: "q2" },
    });
  });

  it("stops at the backstop, which only a bug would reach", () => {
    const daily = setup(
      Array.from({ length: MAX_REQUESTS_PER_DAY }, (_, i) => ({
        id: `old${i}`,
        askerId: "res",
        askerSession: "res-chat",
        targetId: "wri",
        request: `x${i}`,
        status: "answered" as const,
        attempts: 1,
        createdAt: 1_000_000 - 60_000,
      }))
    );
    expect(daily.service.ask("res", "res-chat", "wri", "again")).toEqual({
      error: expect.stringContaining("far more than usual"),
    });
  });

  it("cancels: the other bot stops, and no note comes", async () => {
    const { service, turns, notes, stopTurn, records } = setup();
    service.ask("res", "res-chat", "wri", "draft");
    expect(service.cancel("res", "q1")).toEqual({
      ok: expect.stringContaining("Cancelled request q1"),
    });
    expect(stopTurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q1" })
    );
    turns[0].fail("its turn ended without an answer.");
    await settle();
    expect(records()[0].status).toBe("cancelled");
    expect(notes).toEqual([]);
  });

  it("never lets one bot read or cancel another's requests", () => {
    const { service } = setup();
    service.ask("res", "res-chat", "wri", "draft");
    expect(service.get("pla", "q1")).toBeNull();
    expect(service.cancel("pla", "q1")).toEqual({
      error: "You have no request q1.",
    });
  });

  it("runs a request the app closed on again at start, once", () => {
    const cutOff = (attempts: number): BotAskRecord => ({
      id: `cut${attempts}`,
      askerId: "res",
      askerSession: "res-chat",
      targetId: attempts === 1 ? "wri" : "pla",
      request: "draft",
      status: "running",
      attempts,
      createdAt: 1,
    });
    const { service, turns, notes, records } = setup([cutOff(1), cutOff(2)]);
    service.recover();
    expect(turns.map((turn) => turn.ask.id)).toEqual(["cut1"]);
    expect(records().find((ask) => ask.id === "cut2")?.status).toBe("failed");
    expect(notes[0].note).toContain("the app closed twice");
  });

  it("never re-runs a task the app closed on: it may be half done", () => {
    const { service, turns, notes, records } = setup([
      {
        id: "t1",
        kind: "task",
        userWords: "have Writer post it",
        askerId: "res",
        askerSession: "res-chat",
        targetId: "wri",
        request: "post it",
        status: "running",
        attempts: 1,
        createdAt: 1,
      },
    ]);
    service.recover();
    expect(turns).toEqual([]);
    expect(records()[0].status).toBe("failed");
    expect(notes[0].note).toContain("may be half done");
  });

  it("a deleted bot's own requests are cancelled quietly; ones made to it fail, and the asker hears", () => {
    const { service, stopTurn, notes, records } = setup();
    service.ask("res", "res-chat", "wri", "draft");
    service.ask("pla", "pla-chat", "res", "plan");
    service.forgetBot("res");
    expect(records().map((ask) => ask.status)).toEqual(["cancelled", "failed"]);
    expect(stopTurn).toHaveBeenCalledTimes(2);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ session: "pla-chat" });
    expect(notes[0]!.note).toContain("the user deleted that bot");
  });

  it("fails a queued request whose bot is gone, and says so", () => {
    const { service, notes, records } = setup([
      {
        id: "q9",
        askerId: "res",
        askerSession: "res-chat",
        targetId: "gone",
        request: "x",
        status: "queued",
        attempts: 0,
        createdAt: 1,
      },
    ]);
    service.recover();
    expect(records()[0].status).toBe("failed");
    expect(notes[0].note).toContain("deleted");
  });

  describe("a task the user gave", () => {
    it("runs in the doing bot's own chat with the user's words, all of it shown", () => {
      const { service, turns, records } = setup();
      service.ask("res", "res-chat", "wri", "Draft and post a launch note", {
        kind: "task",
        userWords: "tell Writer to draft and post our launch note",
      });
      expect(records()[0]).toMatchObject({
        kind: "task",
        userWords: "tell Writer to draft and post our launch note",
      });
      expect(turns[0].visibleFrom).toBeNull();
      expect(turns[0].prompt).toContain(
        "[task from the user, passed on by Researcher (Research Scout)]"
      );
      expect(turns[0].prompt).toContain(
        'The user\'s own words, verbatim: "tell Writer to draft and post our launch note"'
      );
      // Not the locked-down rules of an ask.
      expect(turns[0].prompt).not.toContain("It is NOT the user");
    });

    it("reports back as a finished task", async () => {
      const { service, turns, notes } = setup();
      service.ask("res", "res-chat", "wri", "Post it", {
        kind: "task",
        userWords: "post it",
      });
      turns[0].answer("Posted to Slack #launch.");
      await settle();
      expect(notes[0].note).toMatch(
        /^\[bot answer\] Writer finished the task q1/
      );
      expect(notes[0].note).toContain("Posted to Slack #launch.");
    });

    it("runs tasks for one bot one at a time, whoever passed them on", async () => {
      const { service, turns } = setup();
      service.ask("res", "res-chat", "wri", "one", {
        kind: "task",
        userWords: "a",
      });
      const second = service.ask("pla", "pla-chat", "wri", "two", {
        kind: "task",
        userWords: "b",
      });
      expect(second).toMatchObject({ behind: 1 });
      expect(turns).toHaveLength(1);
      turns[0].answer("done one");
      await settle();
      expect(turns.map((turn) => turn.ask.request)).toEqual(["one", "two"]);
    });

    it("runs beside an ask to the same bot: they are different chats", () => {
      const { service, turns } = setup();
      service.ask("res", "res-chat", "wri", "a question");
      service.ask("res", "res-chat", "wri", "a task", {
        kind: "task",
        userWords: "x",
      });
      expect(turns.map((turn) => turn.ask.kind ?? "ask")).toEqual([
        "ask",
        "task",
      ]);
    });
  });
});

describe("daily notes when a request ends", () => {
  it("an answered ask: both sides note it, each from its own side", async () => {
    const { service, turns, note } = setup();
    service.ask(
      "res",
      "res-chat",
      "wri",
      "Draft a one-line post about our new blend"
    );
    turns[0]!.answer(
      "<reply>**Try the new blend** — roasted this week.</reply>"
    );
    await settle();
    expect(note.mock.calls).toEqual([
      [
        "res",
        'Asked Writer: "Draft a one-line post about our new blend"; it answered: Try the new blend — roasted this week.',
      ],
      [
        "wri",
        'Researcher asked me: "Draft a one-line post about our new blend"; I answered: Try the new blend — roasted this week.',
      ],
    ]);
  });

  it("a task that ended early: only the bot that passed it on notes it", async () => {
    const { service, turns, note } = setup();
    service.ask("res", "res-chat", "wri", "Write the launch post", {
      kind: "task",
      userWords: "have Writer write the launch post",
    });
    turns[0]!.fail(
      "the user stopped it partway through, so it may be half done."
    );
    await settle();
    expect(note.mock.calls).toEqual([
      [
        "res",
        'Passed the user\'s task to Writer: "Write the launch post"; it ended: the user stopped it partway through, so it may be half done.',
      ],
    ]);
  });
});
