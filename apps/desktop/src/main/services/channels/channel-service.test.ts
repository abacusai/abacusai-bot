/**
 * ChannelService: the user's message is posted at once and answered by the
 * bots the rules pick, one message at a time per channel. The floor: bots
 * speak one at a time, whoever a reply @names speaks next, and the bot that
 * opened sums up; @everyone speaks in turn; the lead checks in after a while
 * of talk; Stop ends the round and drops what waits.
 */
import type { BotTaskTag } from "@abacus-ai/contract/agent-types";
import type { ChannelMessage } from "@abacus-ai/contract/channels";
import { describe, expect, it, vi } from "vitest";

import { TurnStoppedError } from "../session/turn-stopped";
import { TALK_ROUNDS } from "./channel-logic";
import {
  type ChannelDeps,
  ChannelService,
  type ChannelStore,
  type StoredChannel,
  MAX_LEAD_TURNS,
} from "./channel-service";

const BOTS: Record<string, { id: string; name: string; title: string }> = {
  chief: { id: "chief", name: "Chief", title: "Chief of Staff" },
  res: { id: "res", name: "Researcher", title: "" },
  wri: { id: "wri", name: "Writer", title: "" },
};

const memoryStore = (): ChannelStore & {
  threads: Map<string, ChannelMessage[]>;
} => {
  let channels: StoredChannel[] = [];
  const threads = new Map<string, ChannelMessage[]>();
  return {
    threads,
    readChannels: () => structuredClone(channels),
    writeChannels: (next) => (channels = structuredClone(next)),
    readMessages: (id) => structuredClone(threads.get(id) ?? []),
    writeMessages: (id, messages) => threads.set(id, structuredClone(messages)),
    removeMessages: (id) => threads.delete(id),
  };
};

/** Turns the test answers by hand, in the order they start. */
const setup = (extra: Partial<ChannelDeps> = {}) => {
  const store = memoryStore();
  const turns: Array<{
    botId: string;
    prompt: string;
    resolve: (raw: string) => void;
    reject: (e: Error) => void;
  }> = [];
  const works: Array<
    (typeof turns)[number] & { workId: string; card: BotTaskTag }
  > = [];
  const noted: string[] = [];
  let n = 0;
  let holdWork = false;
  const service = new ChannelService({
    store,
    bot: (id) => BOTS[id] ?? null,
    runTurn: (botId, _channel, prompt) =>
      new Promise((resolve, reject) =>
        turns.push({ botId, prompt, resolve, reject })
      ),
    // The prompt goes at once here unless a test holds it (`holdWork`).
    runWork: (botId, _channel, prompt, workId, card) =>
      new Promise((resolve, reject) => {
        works.push({ botId, prompt, resolve, reject, workId, card });
        if (!holdWork) queueMicrotask(() => service.workStarted(workId));
      }),
    stopWork: vi.fn((workId: string) => {
      works
        .find((entry) => entry.workId === workId)
        ?.reject(new Error("stopped"));
    }),
    createBot: ({ name, title }) => {
      const id = name.toLowerCase();
      BOTS[id] = { id, name, title };
      return BOTS[id]!;
    },
    allBots: () => Object.values(BOTS),
    stopTurn: vi.fn((botId: string) => {
      const turn = turns.find((entry) => entry.botId === botId);
      turn?.reject(new Error("stopped"));
    }),
    changed: vi.fn(),
    note: vi.fn((botId: string, line: string) =>
      noted.push(`${botId}: ${line}`)
    ),
    newId: () => `id${++n}`,
    now: () => 1000 + n,
    ...extra,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const texts = (channelId: string) =>
    (store.threads.get(channelId) ?? []).map(
      (m) => `${m.author.kind === "user" ? "user" : m.author.botId}: ${m.text}`
    );
  return {
    service,
    hold: () => {
      holdWork = true;
    },
    store,
    turns,
    works,
    flush,
    texts,
    noted,
  };
};

/** The turns from the first waiting one on, answered one after another, as the floor runs them. */
const answerInTurn = async (
  turns: ReturnType<typeof setup>["turns"],
  flush: () => Promise<unknown>,
  replies: readonly string[]
): Promise<void> => {
  const from = turns.length - 1;
  for (const [index, reply] of replies.entries()) {
    turns[from + index]!.resolve(reply);
    await flush();
  }
};

describe("ChannelService", () => {
  it("creates a channel with its first message and the lead answers", async () => {
    const { service, turns, flush, texts } = setup();
    const channel = service.create({
      botIds: ["chief", "res", "wri"],
      text: "Where do we start?",
    });
    await flush();
    expect(turns.map((t) => t.botId)).toEqual(["chief"]);
    expect(service.list()[0]?.working).toEqual(["chief"]);
    turns[0]!.resolve("<reply>Start with research.</reply>");
    await flush();
    expect(texts(channel.id)).toEqual([
      "user: Where do we start?",
      "chief: Start with research.",
    ]);
    expect(service.list()[0]?.working).toEqual([]);
  });

  it("refuses fewer than 2 or unknown bots", () => {
    const { service } = setup();
    expect(() => service.create({ botIds: ["chief", "nobody"] })).toThrow(
      /at least 2/
    );
  });

  it("an @mention brings the other bot in; its own @mention brings a third; then the first sums up", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Chief, plan the launch");
    await flush();
    turns[0]!.resolve("<reply>@Researcher who are our competitors?</reply>");
    await flush();
    expect(turns[1]?.botId).toBe("res");
    expect(turns[1]?.prompt).toContain("Chief @named you above");
    expect(turns[1]?.prompt).toContain("@Researcher who are our competitors?");
    turns[1]!.resolve(
      "<reply>Blue Tokai and Starbucks. @Writer could use this.</reply>"
    );
    await flush();
    expect(turns[2]?.botId).toBe("wri");
    expect(turns[2]?.prompt).toContain("Researcher @named you above");
    turns[2]!.resolve("<reply>Tagline: better than Blue Tokai.</reply>");
    await flush();
    expect(turns[3]?.botId).toBe("chief");
    expect(turns[3]?.prompt).toContain("Researcher, Writer answered above");
    turns[3]!.resolve("<reply>Plan: undercut Blue Tokai.</reply>");
    await flush();
    expect(turns).toHaveLength(4);
    expect(texts(id).slice(1)).toEqual([
      "chief: @Researcher who are our competitors?",
      "res: Blue Tokai and Starbucks. @Writer could use this.",
      "wri: Tagline: better than Blue Tokai.",
      "chief: Plan: undercut Blue Tokai.",
    ]);
  });

  it("bots named in order answer in order, the second seeing the first", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Researcher find complaints, then Writer make a caption");
    await flush();
    turns[0]!.resolve("<reply>Queues are too long.</reply>");
    await flush();
    expect(turns[1]?.botId).toBe("wri");
    expect(turns[1]?.prompt).toContain("Queues are too long.");
  });

  it("a bot the user named is not brought in early: no follow-up for it", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Researcher find complaints, then Writer make a caption");
    await flush();
    turns[0]!.resolve("<reply>Queues. @Writer over to you.</reply>");
    await flush();
    expect(turns[1]?.botId).toBe("wri");
    expect(turns[1]?.prompt).toContain("Answer the user's latest message");
    turns[1]!.resolve("<reply>Skip the queue.</reply>");
    await flush();
    expect(turns).toHaveLength(2);
    expect(texts(id)).toHaveLength(3);
  });

  it("@everyone answers in turn, each seeing the answers before it", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "@everyone biggest risk?");
    await flush();
    // One at a time: the next starts only once the one before has answered.
    expect(turns.map((t) => t.botId)).toEqual(["chief"]);
    expect(turns[0]!.prompt).toContain("each member answers once, in turn");
    turns[0]!.resolve("<reply>Timing.</reply>");
    await flush();
    expect(turns.map((t) => t.botId)).toEqual(["chief", "res"]);
    expect(turns[1]!.prompt).toContain("Timing.");
    turns[1]!.resolve("<reply>Price.</reply>");
    await flush();
    expect(turns[2]!.botId).toBe("wri");
    expect(turns[2]!.prompt).toContain("Timing.");
    expect(turns[2]!.prompt).toContain("Price.");
    turns[2]!.resolve("<reply>Copy.</reply>");
    await flush();
    // The one that opened sums up, or passes when there is nothing to sum up.
    expect(turns).toHaveLength(4);
    expect(turns[3]!.botId).toBe("chief");
    turns[3]!.resolve(
      "<reply>Agreed:\n1. Watch timing — Chief\n2. Check price — Researcher</reply>"
    );
    await flush();
    expect(texts(id)).toHaveLength(5);
    expect(service.thread(id).messages.at(-1)!.conclusion).toBe(true);
  });

  it("'Agreed: nothing to run yet' over a list of debate points is no plan", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "@everyone should we open at 6am?");
    await flush();
    turns[0]!.resolve("<reply>Yes, trial it.</reply>");
    await flush();
    turns[1]!.resolve("<reply>Only with a pass bar.</reply>");
    await flush();
    turns[2]!.resolve(
      "<reply>**Agreed:** nothing to run yet, this is a debate.\n1. A six-week trial.\n2. A pass bar.</reply>"
    );
    await flush();
    expect(service.thread(id).messages.at(-1)!.conclusion).toBeUndefined();
  });

  it("thanks gets no answer", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "thanks all!");
    await flush();
    expect(turns).toHaveLength(0);
  });

  it("one message at a time; a bot is shown only what it has not seen", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "first");
    service.post(id, "second");
    await flush();
    expect(turns).toHaveLength(1);
    expect(service.list()[0]?.queued).toBe(1);
    turns[0]!.resolve("<reply>one</reply>");
    await flush();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toContain("second");
    expect(turns[1]!.prompt).not.toContain(">\nfirst\n<");
    expect(turns[1]!.prompt).not.toContain(">\none\n<");
  });

  it("Stop ends the round and drops the queue; only the cut-off bot's trace is posted", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "first");
    service.post(id, "second");
    await flush();
    service.stop(id);
    await flush();
    expect(turns).toHaveLength(1);
    expect(texts(id)).toEqual([
      "user: first",
      "user: second",
      "chief: Chief was stopped before answering.",
    ]);
    expect(service.list()[0]).toMatchObject({ working: [], queued: 0 });
  });

  it("a failed turn is posted as such; the round goes on", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief and Researcher: go");
    await flush();
    turns[0]!.reject(new Error("it took too long."));
    await flush();
    expect(store.threads.get(id)?.[1]).toMatchObject({
      failed: true,
      text: "Chief couldn't answer: it took too long.",
    });
    expect(turns[1]?.botId).toBe("res");
  });

  it("decided: pins a decision every bot sees", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Decided: price is ₹149");
    await flush();
    expect(service.list()[0]?.decisions.map((d) => d.text)).toEqual([
      "price is ₹149",
    ]);
    expect(turns[0]!.prompt).toContain("- price is ₹149");
    expect(turns[0]!.prompt).toMatch(/Today is \w+day,? \d+ \w+ 1970\./);
  });

  it("the card waits while the bot's own chat is busy, and the bot is told so", async () => {
    const { service, turns, works, flush, store, hold } = setup();
    hold();
    const { id } = service.create({ botIds: ["chief", "wri"], name: "Launch" });
    service.post(id, "Writer, write the launch email as a doc");
    await flush();
    turns[0]!.resolve(
      "<reply>Writing it now.<work>Write the launch email as launch-email.md</work></reply>"
    );
    await flush();
    const card = () => store.threads.get(id)![1]!.work;
    expect(card()).toMatchObject({ status: "waiting" });
    expect(card()?.endedAt).toBeUndefined();
    // Busy (the Stop button), but not writing in the channel (no bubble).
    expect(service.list()[0]?.working).toEqual(["wri"]);
    expect(service.list()[0]?.answering).toEqual([]);
    service.post(id, "Writer, how is it going?");
    await flush();
    expect(turns[1]!.prompt).toContain(
      '- "Write the launch email as launch-email.md": not started yet; it waits for your own chat'
    );
    expect(turns[1]!.prompt).toContain("<stop_work/>");
    turns[1]!.resolve("<reply>Queued behind my current turn.</reply>");
    await flush();
    // The host sends the prompt once the chat is free.
    service.workStarted(works[0]!.workId);
    expect(card()).toMatchObject({ status: "running" });
    expect(card()?.endedAt).toBeUndefined();
    works[0]!.resolve("<reply>Done.</reply>");
    await flush();
    expect(card()).toMatchObject({ status: "done" });
    expect(card()?.endedAt).toBeDefined();
  });

  it("stopped while waiting, the card says it never started; after a restart, that the app closed first", async () => {
    const { service, turns, flush, store, hold } = setup();
    hold();
    const { id } = service.create({ botIds: ["chief", "wri"], name: "Launch" });
    service.post(id, "Writer, write the launch email as a doc");
    await flush();
    turns[0]!.resolve(
      "<reply>Writing it now.<work>Write the launch email as launch-email.md</work></reply>"
    );
    await flush();
    // A copy closed while waiting: recovery names it.
    const thread = store.readMessages(id);
    const again = setup();
    again.store.writeChannels(store.readChannels());
    again.store.writeMessages(id, thread);
    again.service.recover();
    expect(again.store.readMessages(id)[1]!.work).toMatchObject({
      status: "failed",
      error: "The app closed before it started.",
    });
    // The live one is stopped by the user.
    service.stop(id);
    await flush();
    expect(store.threads.get(id)![1]!.work).toMatchObject({
      status: "stopped",
      error: "You stopped it before it started.",
    });
  });

  it("a deleted bot leaves its channels", () => {
    const { service } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.forgetBot("wri");
    expect(service.thread(id).channel.memberBotIds).toEqual(["chief", "res"]);
  });
  it("one bot left still answers; with none left, a message is refused", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.forgetBot("res");
    service.post(id, "still there?");
    await flush();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.botId).toBe("chief");
    turns[0]!.resolve("<reply>Yes.</reply>");
    await flush();
    service.forgetBot("chief");
    expect(() => service.post(id, "hello?")).toThrow("no bots left");
    expect(service.thread(id).messages).toHaveLength(2);
  });
  it("after a restart, a message no bot answered is answered; a half-answered one is not", async () => {
    const first = setup();
    const { id } = first.service.create({
      botIds: ["chief", "res"],
      about: "Launch Brewly",
    });
    first.service.post(id, "Chief and Researcher: go");
    await first.flush();
    first.turns[0]!.resolve("<reply>On it.</reply>");
    await first.flush();
    first.service.post(id, "second question");
    // The app closes here: Researcher's turn and "second question" never ran.
    const channels = first.store.readChannels();
    const thread = first.store.readMessages(id);
    const again = setup();
    again.store.writeChannels(channels);
    again.store.writeMessages(id, thread);
    again.service.recover();
    await again.flush();
    expect(again.turns).toHaveLength(1);
    expect(again.turns[0]!.prompt).toContain("second question");
    expect(again.turns[0]!.prompt).toContain(
      "What this channel is for (the user's words): Launch Brewly"
    );
    again.turns[0]!.resolve("<reply>Answer.</reply>");
    await again.flush();
    expect(again.store.readChannels()[0]?.pending).toEqual([]);
  });
});

describe("work taken on in a channel", () => {
  it("runs in the bot's own chat; the card tracks it and the report is posted", async () => {
    const { service, turns, works, flush, store, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"], name: "Launch" });
    service.post(id, "Writer, write the launch email as a doc");
    await flush();
    turns[0]!.resolve(
      "<reply>Writing it now.<work>Write the launch email as launch-email.md</work></reply>"
    );
    await flush();
    const card = store.threads.get(id)![1]!;
    expect(card).toMatchObject({
      text: "Writing it now.",
      work: {
        task: "Write the launch email as launch-email.md",
        status: "running",
      },
    });
    expect(works).toHaveLength(1);
    expect(works[0]!.prompt).toMatch(
      /^\[task from the user, passed on by channel "Launch"\]/
    );
    // Its task only: the user's channel message stays in the channel.
    expect(works[0]!.prompt).toContain(
      "Task: Write the launch email as launch-email.md"
    );
    expect(works[0]!.prompt).not.toContain(
      "Writer, write the launch email as a doc"
    );
    // Its own chat draws the work as a card from the channel.
    expect(works[0]!.card).toEqual({
      askId: card.id,
      passerId: id,
      passer: "Launch",
      channelId: id,
      task: "Write the launch email as launch-email.md",
      userWords: "Write the launch email as launch-email.md",
    });
    expect(service.list()[0]?.working).toEqual(["wri"]);
    // The channel goes on meanwhile.
    service.post(id, "Chief, anything else?");
    await flush();
    expect(turns[1]?.botId).toBe("chief");
    turns[1]!.resolve("<reply>No.</reply>");
    works[0]!.resolve(
      "<reply>Done: launch-email.md in your workspace.</reply>"
    );
    await flush();
    expect(store.threads.get(id)![1]!.work?.status).toBe("done");
    expect(texts(id).at(-1)).toBe(
      "wri: Done: launch-email.md in your workspace."
    );
    // The lead picks the goal up after the report; nothing more needed here.
    expect(turns[2]?.botId).toBe("chief");
    expect(turns[2]!.prompt).toContain("Writer's work just ended above");
    turns[2]!.resolve("<reply>NO_REPLY</reply>");
    await flush();
    expect(service.list()[0]?.working).toEqual([]);
  });

  it("a bot brought in that the user never named cannot take work on; an @everyone round starts none either", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Chief, get someone to save the email");
    await flush();
    turns[0]!.resolve("<reply>@Writer save it</reply>");
    await flush();
    expect(turns[1]!.prompt).toContain("You can't take work");
    turns[1]!.resolve("<reply>I would <work>save the email</work></reply>");
    await flush();
    // Chief opened and @named Writer: it sums up.
    expect(turns[2]!.prompt).toContain("Writer answered above");
    turns[2]!.resolve("<reply>Done.</reply>");
    await flush();
    expect(works).toHaveLength(0);
    expect(store.threads.get(id)![2]).toMatchObject({ text: "I would" });
    expect(store.threads.get(id)![2]!.work).toBeUndefined();
    service.post(id, "@everyone write your part to notes.md");
    await flush();
    turns[3]!.resolve(
      "<reply>Sure <work>write my part to notes.md</work></reply>"
    );
    await flush();
    turns[4]!.resolve("<reply>Ok</reply>");
    await flush();
    // An @everyone round is talk: its work waits for the agreed list and a go.
    expect(works).toHaveLength(0);
    expect(turns[3]!.prompt).toContain("Start no work in this round");
  });

  it("Stop leaves a trace for each bot cut off before answering", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Chief, get Writer to draft it");
    await flush();
    turns[0]!.resolve("<reply>@Writer draft it</reply>");
    await flush();
    expect(turns[1]!.botId).toBe("wri");
    service.stop(id);
    turns[1]!.reject(new Error("stopped"));
    await flush();
    expect(texts(id).slice(-1)).toEqual([
      "wri: Writer was stopped before answering.",
    ]);
    expect(texts(id)).toHaveLength(3);
    // The next turn reads it as the bot's failed answer.
    service.post(id, "Chief, where are we?");
    await flush();
    expect(turns[2]!.prompt).toContain("Writer was stopped before answering.");
  });

  it("Stop stops the work; it is marked stopped and no report is posted", async () => {
    const { service, turns, works, flush, store } = setup();
    expect(works).toHaveLength(0);
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, make the deck");
    await flush();
    turns[0]!.resolve("<reply><work>Make the deck</work></reply>");
    await flush();
    expect(store.threads.get(id)![1]!.text).toBe("On it: Make the deck");
    service.stop(id);
    await flush();
    expect(store.threads.get(id)![1]!.work).toMatchObject({
      status: "stopped",
    });
    expect(store.threads.get(id)).toHaveLength(2);
  });

  it("the bot sees what became of its work, and can stop it when the user cancels", async () => {
    const { service, turns, works, flush, store, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, write the announcement to announcement.md");
    await flush();
    turns[0]!.resolve(
      "<reply>On it.<work>Write the announcement to announcement.md</work></reply>"
    );
    await flush();
    service.post(
      id,
      "Writer, I changed my mind, I don't need the announcement anymore"
    );
    await flush();
    expect(turns[1]!.prompt).toContain(
      '- "Write the announcement to announcement.md": running now'
    );
    expect(turns[1]!.prompt).toContain("<stop_work/>");
    turns[1]!.resolve("<reply>Stopped it.<stop_work/></reply>");
    await flush();
    expect(store.threads.get(id)![1]!.work?.status).toBe("stopped");
    expect(texts(id).at(-1)).toBe("wri: Stopped it.");
    // Next time it is told the work was stopped, not that it is running.
    service.post(id, "Writer, did you finish it?");
    await flush();
    expect(turns[2]!.prompt).toContain(
      "the user stopped it partway, so it may be half done"
    );
    expect(turns[2]!.prompt).not.toContain("<stop_work/>");
    expect(works).toHaveLength(1);
  });

  it("a changed task stops the old work first and starts the new one", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, write the announcement");
    await flush();
    turns[0]!.resolve("<reply><work>Write the announcement</work></reply>");
    await flush();
    service.post(id, "Writer, make it under 50 words");
    await flush();
    turns[1]!.resolve(
      "<reply>Shorter, then.<stop_work/><work>Write the announcement in under 50 words</work></reply>"
    );
    await flush();
    const cards = store.threads
      .get(id)!
      .filter((message) => message.work != null);
    expect(cards.map((card) => card.work!.status)).toEqual([
      "stopped",
      "running",
    ]);
    expect(works.map((work) => work.workId)).toEqual([
      cards[0]!.id,
      cards[1]!.id,
    ]);
  });

  it("a plain stop stops the work of the bots it names before they answer", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, write the announcement and Chief, the checklist");
    await flush();
    turns[0]!.resolve("<reply><work>Write the announcement</work></reply>");
    await flush();
    turns[1]!.resolve("<reply><work>Make the checklist</work></reply>");
    await flush();
    expect(works.map((work) => work.botId)).toEqual(["wri", "chief"]);
    service.post(id, "Chief stop, Writer carry on");
    await flush();
    const status = (botId: string) =>
      store.threads
        .get(id)!
        .find(
          (m) =>
            m.work != null &&
            m.author.kind === "bot" &&
            m.author.botId === botId
        )!.work!.status;
    expect(status("chief")).toBe("stopped");
    expect(status("wri")).toBe("running");
    // Naming nobody stops everything still running (once Chief has answered).
    turns[2]!.resolve("<reply>Stopped.</reply>");
    await flush();
    service.post(id, "stop");
    await flush();
    expect(status("wri")).toBe("stopped");
    // Chief is told at once that its work stopped.
    expect(turns[2]!.botId).toBe("chief");
    expect(turns[2]!.prompt).toContain(
      "the user stopped it partway, so it may be half done"
    );
  });

  it("work waits when the bot asks the user whether to start it", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, did you finish the announcement?");
    await flush();
    turns[0]!.resolve(
      "<reply>Not finished: it was stopped. Want me to run it again?<work>Write the announcement</work></reply>"
    );
    await flush();
    expect(works).toHaveLength(0);
    expect(store.threads.get(id)![1]).toMatchObject({
      text: "Not finished: it was stopped. Want me to run it again?",
    });
    expect(store.threads.get(id)![1]!.work).toBeUndefined();
  });

  it("Stop while the work still waits to start: nothing shows as working", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, make the deck");
    await flush();
    turns[0]!.resolve("<reply><work>Make the deck</work></reply>");
    await flush();
    expect(service.list()[0]?.working).toEqual(["wri"]);
    service.stop(id);
    await flush();
    expect(service.list()[0]?.working).toEqual([]);
    // A report arriving after the stop changes nothing.
    works[0]!.resolve("<reply>Deck done.</reply>");
    await flush();
    expect(store.threads.get(id)![1]!.work?.status).toBe("stopped");
    expect(store.threads.get(id)).toHaveLength(2);
  });

  it("a member removed, or a bot deleted, has its work stopped", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri", "res"] });
    service.post(id, "Writer, make the deck");
    await flush();
    turns[0]!.resolve("<reply><work>Make the deck</work></reply>");
    await flush();
    service.update(id, { botIds: ["chief", "res"] });
    await flush();
    expect(store.threads.get(id)![1]!.work).toMatchObject({
      status: "stopped",
      error: "Writer left the channel, so its work stopped.",
    });
    service.post(id, "Researcher, find prices");
    await flush();
    turns[1]!.resolve("<reply><work>Find prices</work></reply>");
    await flush();
    service.forgetBot("res");
    expect(store.threads.get(id)![3]!.work).toMatchObject({
      status: "stopped",
      error: "The bot was deleted, so its work stopped.",
    });
  });

  it("a channel removed mid-work is not written back by the late report", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, make the deck");
    await flush();
    turns[0]!.resolve("<reply><work>Make the deck</work></reply>");
    await flush();
    service.remove(id);
    works[0]!.resolve("<reply>Deck done.</reply>");
    await flush();
    expect(store.threads.has(id)).toBe(false);
  });

  it("work written just after the reply still starts", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, as a work task, write launch-email.md");
    await flush();
    turns[0]!.resolve(
      "<reply>Writing the launch email now.</reply>\n\n<work>Write launch-email.md: a 120-word launch email</work>"
    );
    await flush();
    expect(works).toHaveLength(1);
    expect(works[0]!.botId).toBe("wri");
    expect(service.thread(id).messages.at(-1)!.text).not.toContain("<work>");
  });
  it("a bot cannot stop another bot's work", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, write the announcement");
    await flush();
    turns[0]!.resolve("<reply><work>Write the announcement</work></reply>");
    await flush();
    service.post(id, "Chief, what do you think?");
    await flush();
    expect(turns[1]!.prompt).not.toContain("Work you took on here");
    turns[1]!.resolve("<reply>Looks fine.<stop_work/></reply>");
    await flush();
    expect(store.threads.get(id)![1]!.work?.status).toBe("running");
  });

  it("work the app closed on is marked failed after a restart", async () => {
    const first = setup();
    const { id } = first.service.create({ botIds: ["chief", "wri"] });
    first.service.post(id, "Writer, make the deck");
    await first.flush();
    first.turns[0]!.resolve("<reply>On it <work>Make the deck</work></reply>");
    await first.flush();
    const again = setup();
    again.store.writeChannels(first.store.readChannels());
    again.store.writeMessages(id, first.store.readMessages(id));
    again.service.recover();
    expect(again.store.readMessages(id)[1]!.work).toMatchObject({
      status: "failed",
    });
    expect(again.store.readMessages(id)[1]!.work?.error).toMatch(/app closed/);
  });
});

describe("the team working it out together", () => {
  it("Stop mid-exchange ends it: nobody else speaks and the opener does not sum up", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Discuss whether we should launch on Dec 19");
    await flush();
    turns[0]!.resolve("<reply>Yes. @Researcher @Writer agree?</reply>");
    await flush();
    expect(turns[1]!.botId).toBe("res");
    service.stop(id);
    await flush();
    expect(turns).toHaveLength(2);
    expect(texts(id).at(-1)).toBe(
      "res: Researcher was stopped before answering."
    );
  });
});

describe("the floor", () => {
  it("two bots @naming each other keep going without the user, and stop when a reply names nobody", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Chief, settle the price with Researcher");
    await flush();
    await answerInTurn(turns, flush, [
      "<reply>@Researcher ₹99?</reply>",
      "<reply>@Chief ₹120?</reply>",
      "<reply>@Researcher ₹110?</reply>",
      "<reply>@Chief fine, ₹110.</reply>",
      "<reply>Settled: ₹110.</reply>",
    ]);
    expect(turns.map((t) => t.botId)).toEqual([
      "chief",
      "res",
      "chief",
      "res",
      "chief",
    ]);
    expect(turns[2]!.prompt).toContain("Researcher @named you above");
    expect(turns[2]!.prompt).toContain("@Chief ₹120?");
    // Chief opened and spoke last: no summing-up after its own last word.
    expect(turns).toHaveLength(5);
  });
});

describe("the floor's edges", () => {
  it("two user messages that waited are each answered by their own round", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, one");
    await flush();
    service.post(id, "Researcher, two");
    service.post(id, "Chief, three");
    turns[0]!.resolve("<reply>One.</reply>");
    await flush();
    expect(turns[1]?.botId).toBe("res");
    turns[1]!.resolve("<reply>Two.</reply>");
    await flush();
    expect(turns[2]?.botId).toBe("chief");
    expect(turns).toHaveLength(3);
  });
});

describe("the lead checks in after a while of talk", () => {
  const PLANNER = { id: "pla", name: "Planner", title: "" };
  /** Chief and Researcher @name each other back and forth, `count` times. */
  const talkFor = async (botIds: string[], count: number) => {
    const t = setup();
    const { id } = t.service.create({ botIds });
    t.service.post(id, "Chief, settle the price with Researcher");
    for (let i = 0; i < count; i++) {
      await t.flush();
      const other = t.turns[i]!.botId === "chief" ? "Researcher" : "Chief";
      t.turns[i]!.resolve(`<reply>@${other} point ${i}</reply>`);
    }
    await t.flush();
    return { ...t, id };
  };

  it.each([2, 4])(
    "with %i members, after 3 talk messages each, the lead gets one check-in turn",
    async (size) => {
      BOTS.pla = PLANNER;
      try {
        const botIds = ["chief", "res", "wri", "pla"].slice(0, size);
        const talk = TALK_ROUNDS * size;
        const { turns } = await talkFor(botIds, talk);
        expect(turns).toHaveLength(talk + 1);
        expect(turns[talk - 1]!.prompt).toContain("@named you above");
        expect(turns[talk]!.botId).toBe("chief");
        expect(turns[talk]!.prompt).toContain(
          "talking among themselves for a while"
        );
      } finally {
        delete BOTS.pla;
      }
    }
  );

  it("after the check-in no bot speaks until the user posts; then they answer again", async () => {
    const { service, turns, flush, store, id } = await talkFor(
      ["chief", "res"],
      6
    );
    turns[6]!.resolve(
      "<reply>Agreed:\n1. ₹110 (Researcher)\nStill open: launch day. Go on?</reply>"
    );
    await flush();
    // The check-in's Agreed: is a conclusion, and Researcher's @Chief waits.
    expect(store.readMessages(id).at(-1)?.conclusion).toBe(true);
    expect(turns).toHaveLength(7);
    service.post(id, "Researcher, what about the launch day?");
    await flush();
    expect(turns[7]!.botId).toBe("res");
    expect(turns[7]!.prompt).toContain("Answer the user's latest message");
    turns[7]!.resolve("<reply>@Chief Friday?</reply>");
    await flush();
    expect(turns[8]!.botId).toBe("chief");
    expect(turns[8]!.prompt).toContain("Researcher @named you above");
  });
});

describe("bots proposing a new bot", () => {
  it("shows a proposal; only the user's Create makes the bot and adds it", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, we keep needing numbers. What should we do?");
    await flush();
    turns[0]!.resolve(
      '<reply>We need a numbers owner. <new_bot name="Analyst" title="Finance analyst">Owns budgets, unit economics and forecasts.</new_bot></reply>'
    );
    await flush();
    const message = store.threads.get(id)![1]!;
    expect(message).toMatchObject({
      text: "We need a numbers owner.",
      proposal: {
        name: "Analyst",
        title: "Finance analyst",
        status: "proposed",
      },
    });
    expect(service.thread(id).channel.memberBotIds).toEqual(["chief", "res"]);
    service.decideProposal(id, message.id, true);
    expect(service.thread(id).channel.memberBotIds).toEqual([
      "chief",
      "res",
      "analyst",
    ]);
    expect(store.threads.get(id)![1]!.proposal).toMatchObject({
      status: "created",
      botId: "analyst",
    });
    expect(() => service.decideProposal(id, message.id, true)).toThrow(
      /already decided/
    );
    delete BOTS.analyst;
  });

  it("a brought-in bot cannot propose, and a name already taken is ignored", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, plan it");
    await flush();
    turns[0]!.resolve(
      '<reply>Here. <new_bot name="Writer" title="">Writes.</new_bot></reply>'
    );
    await flush();
    expect(store.threads.get(id)![1]!.proposal).toBeUndefined();
    expect(store.threads.get(id)![1]!.text).toBe("Here.");
  });
});

describe("the user speaks during an exchange", () => {
  it("ends it after the current turn, with no summing-up; then the message is answered once", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({
      botIds: ["chief", "res", "wri"],
      text: "agree on a launch price",
    });
    await flush();
    turns[0]!.resolve("<reply>₹120. @Researcher your view?</reply>");
    await flush();
    service.post(id, "must be under ₹100");
    turns[1]!.resolve("<reply>₹150. @Chief too high?</reply>");
    await flush();
    // Chief, @named, does not speak; the user's message is answered next.
    expect(turns[2]!.botId).toBe("chief");
    expect(turns[2]!.prompt).toContain("Answer the user's latest message");
    expect(turns[2]!.prompt).toContain("under ₹100");
    turns[2]!.resolve("<reply>Under ₹100 then.</reply>");
    await flush();
    expect(turns).toHaveLength(3);
    const bots = store.threads.get(id)!.filter((m) => m.author.kind === "bot");
    expect(bots.map((m) => m.text)).toEqual([
      "₹120. @Researcher your view?",
      "₹150. @Chief too high?",
      "Under ₹100 then.",
    ]);
  });
});

describe("what the channel settles goes into the members' daily notes", () => {
  it("a pin, an unpin, and finished work, each tagged with the channel", async () => {
    const { service, turns, works, flush, noted } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"], name: "Launch" });
    service.post(id, "Decided: launch on Dec 19");
    await flush();
    expect(noted).toEqual([
      'chief: [channel "Launch"] Decided: launch on Dec 19',
      'wri: [channel "Launch"] Decided: launch on Dec 19',
    ]);
    turns[0]!.resolve("<reply>Noted.</reply>");
    await flush();
    const pin = service.list()[0]!.decisions[0]!;
    service.unpin(id, pin.id);
    expect(noted.at(-1)).toBe(
      'wri: [channel "Launch"] No longer settled: launch on Dec 19'
    );
    service.post(id, "Writer, write the announcement");
    await flush();
    turns[1]!.resolve(
      "<reply>On it.<work>Write the announcement</work></reply>"
    );
    await flush();
    works[0]!.resolve("<reply>Wrote announcement.md: 120 words.</reply>");
    await flush();
    expect(noted.at(-1)).toBe(
      'wri: [channel "Launch"] I did: Write the announcement — Wrote announcement.md: 120 words.'
    );
    expect(noted.filter((line) => line.includes("I did"))).toHaveLength(1);
  });

  it("the opener's Agreed: summing-up, to every member", async () => {
    const { service, turns, flush, noted } = setup();
    const { id } = service.create({
      botIds: ["chief", "res", "wri"],
      name: "Launch",
      text: "agree on a price",
    });
    await flush();
    turns[0]!.resolve("<reply>₹99? @everyone</reply>");
    for (let i = 1; i < 3; i++) {
      await flush();
      turns[i]!.resolve("<reply>₹99.</reply>");
    }
    await flush();
    expect(noted).toEqual([]);
    turns[3]!.resolve("<reply>Agreed: 1. ₹99 (Chief)</reply>");
    await flush();
    expect(noted).toEqual([
      'chief: [channel "Launch"] The team agreed, summed up by Chief: Agreed: 1. ₹99 (Chief)',
      'res: [channel "Launch"] The team agreed, summed up by Chief: Agreed: 1. ₹99 (Chief)',
      'wri: [channel "Launch"] The team agreed, summed up by Chief: Agreed: 1. ₹99 (Chief)',
    ]);
    expect(service.list()[0]!.id).toBe(id);
  });
});

describe("the user's go-ahead in words", () => {
  it("after the team's Agreed:, 'yes, go ahead' starts the work as the button would, and nobody answers it", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({
      botIds: ["chief", "res", "wri"],
      text: "discuss and agree on two tasks",
    });
    await flush();
    turns[0]!.resolve("<reply>@everyone one task each?</reply>");
    for (let i = 1; i < 3; i++) {
      await flush();
      turns[i]!.resolve("<reply>A task each.</reply>");
    }
    await flush();
    turns[3]!.resolve(
      "<reply>Agreed:\n1. Researcher lists the suppliers.\n2. Writer drafts the sign.</reply>"
    );
    await flush();
    service.post(id, "yes, go ahead");
    await flush();
    expect(works.map((work) => work.botId)).toEqual(["res", "wri"]);
    // Their own words started it: no second message in the user's name.
    expect(
      store
        .readMessages(id)
        .filter((m) => m.author.kind === "user")
        .map((m) => m.text)
    ).toEqual(["discuss and agree on two tasks", "yes, go ahead"]);
    expect(store.readMessages(id).find((m) => m.conclusion)?.planStarted).toBe(
      true
    );
    expect(turns).toHaveLength(4);
    // Once started, a second yes is an ordinary message (here: a plain
    // acknowledgement nobody answers), and starts nothing again.
    service.post(id, "yes");
    await flush();
    expect(works).toHaveLength(2);
    expect(turns).toHaveLength(4);
  });
});

describe("starting the agreed work", () => {
  it("one card per owner, with all its items, in its own chat; once", async () => {
    const { service, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    store.writeMessages(id, [
      {
        id: "c2",
        author: { kind: "bot", botId: "chief" },
        text: "Agreed:\n1. @Writer the DM\n2. Researcher the list\n3. @Writer the poster",
        at: 1,
        conclusion: true,
      },
    ]);
    service.startAgreed(id, "c2");
    await flush();
    expect(works.map((w) => w.botId)).toEqual(["wri", "res"]);
    expect(works[0]!.prompt).toContain(
      "1. @Writer the DM\n2. @Writer the poster"
    );
    expect(store.readMessages(id).filter((m) => m.work != null)).toHaveLength(
      2
    );
  });

  it("the lead is not woken after agreed work: the plan is the scope", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    store.writeMessages(id, [
      {
        id: "c3",
        author: { kind: "bot", botId: "chief" },
        text: "Agreed:\n1. @Writer the DM\n2. Researcher the list",
        at: 1,
        conclusion: true,
      },
    ]);
    service.startAgreed(id, "c3");
    await flush();
    works[0]!.resolve("<reply>DM written.</reply>");
    works[1]!.resolve("<reply>List done.</reply>");
    await flush();
    expect(turns).toHaveLength(0);
  });

  it("sends each agreed item to its owner's own chat as work, with a card each; once", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Decided: launch Dec 19");
    await flush();
    turns[0]!.resolve("<reply>Noted.</reply>");
    await flush();
    store.writeMessages(id, [
      ...store.readMessages(id),
      {
        id: "c1",
        author: { kind: "bot", botId: "chief" },
        text: "Agreed:\n1. Researcher owns the hostel list\n2. @Writer writes the DM\n3. Book the stall",
        at: 5,
        conclusion: true,
      },
    ]);
    service.startAgreed(id, "c1");
    await flush();
    expect(works.map((w) => w.botId)).toEqual(["res", "wri", "chief"]);
    expect(works[0]!.prompt).toContain(
      "The team agreed a plan in the channel and the user started it"
    );
    expect(works[0]!.prompt).toContain("Task: Researcher owns the hostel list");
    expect(works[0]!.prompt).toContain("- launch Dec 19");
    const cards = store.readMessages(id).filter((m) => m.work != null);
    expect(cards.map((m) => m.work!.status)).toEqual([
      "running",
      "running",
      "running",
    ]);
    expect(store.readMessages(id).find((m) => m.id === "c1")!.planStarted).toBe(
      true
    );
    expect(() => service.startAgreed(id, "c1")).toThrow(/already started/);
    works[1]!.resolve("<reply>DM written: dm.md</reply>");
    await flush();
    expect(store.readMessages(id).at(-1)).toMatchObject({
      author: { kind: "bot", botId: "wri" },
      text: "DM written: dm.md",
    });
  });
});

describe("edge cases", () => {
  it("two channels run at the same time, independently", async () => {
    const { service, turns, flush, texts } = setup();
    const a = service.create({ botIds: ["chief", "res"] }).id;
    const b = service.create({ botIds: ["chief", "wri"] }).id;
    service.post(a, "Chief, A?");
    service.post(b, "Chief, B?");
    await flush();
    expect(turns).toHaveLength(2);
    turns[1]!.resolve("<reply>for B</reply>");
    turns[0]!.resolve("<reply>for A</reply>");
    await flush();
    expect(texts(a)).toEqual(["user: Chief, A?", "chief: for A"]);
    expect(texts(b)).toEqual(["user: Chief, B?", "chief: for B"]);
  });

  it("a bot removed from the channel mid-answer is stopped and posts nothing", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Writer, a tagline");
    await flush();
    service.update(id, { botIds: ["chief", "res"] });
    await flush();
    expect(texts(id)).toEqual(["user: Writer, a tagline"]);
    expect(service.list()[0]?.working).toEqual([]);
    expect(turns).toHaveLength(1);
  });

  it("a channel deleted mid-round leaves nothing behind and does not throw", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief and Researcher: go");
    await flush();
    service.remove(id);
    turns[0]?.resolve("<reply>late</reply>");
    await flush();
    expect(service.list()).toEqual([]);
    expect(store.threads.has(id)).toBe(false);
    expect(() => service.post(id, "hello?")).toThrow(/gone/);
  });

  it("NO_REPLY and an empty answer post nothing", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, anything?");
    await flush();
    turns[0]!.resolve("<reply>NO_REPLY</reply>");
    await flush();
    service.post(id, "Chief, and now?");
    await flush();
    turns[1]!.resolve("");
    await flush();
    expect(texts(id)).toEqual([
      "user: Chief, anything?",
      "user: Chief, and now?",
    ]);
  });

  it("a turn that throws at once is reported as failed; the next message still runs", async () => {
    const store = memoryStore();
    let calls = 0;
    const service = new ChannelService({
      store,
      bot: (id) => BOTS[id] ?? null,
      runTurn: () => {
        calls++;
        if (calls === 1) throw new Error("no workspace");
        return Promise.resolve("<reply>ok</reply>");
      },
      stopTurn: () => {},
      changed: () => {},
    });
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, one");
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.post(id, "Chief, two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const thread = store.readMessages(id);
    expect(thread[1]).toMatchObject({ failed: true });
    expect(thread.at(-1)).toMatchObject({ text: "ok" });
  });

  it("a long thread: a bot's first turn sees the last 30, later turns only what is new", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    store.writeMessages(
      id,
      Array.from({ length: 60 }, (_, index) => ({
        id: `old${index}`,
        author: { kind: "user" as const },
        text: `note ${index}`,
        at: index,
      }))
    );
    service.post(id, "Researcher, what now?");
    await flush();
    expect(turns[0]!.prompt).toContain("earlier ones not shown");
    expect(turns[0]!.prompt).not.toContain(">\nnote 0\n<");
    expect(turns[0]!.prompt).toContain(">\nnote 59\n<");
  });

  it("more than 6 bots, or fewer than 2, are refused", () => {
    const { service } = setup();
    const extras = ["x", "y", "z", "q"];
    for (const extra of extras)
      BOTS[extra] = { id: extra, name: extra.toUpperCase(), title: "" };
    expect(() =>
      service.create({ botIds: ["chief", "res", "wri", ...extras] })
    ).toThrow(/at most 6/);
    for (const extra of extras) delete BOTS[extra];
    expect(() =>
      service.update(service.create({ botIds: ["chief", "res"] }).id, {
        botIds: ["chief"],
      })
    ).toThrow(/at least 2/);
  });

  it("a user message right after Stop is answered", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, long thing");
    await flush();
    service.stop(id);
    await flush();
    service.post(id, "Chief, short thing");
    await flush();
    expect(turns.at(-1)!.prompt).toContain("short thing");
    turns.at(-1)!.resolve("<reply>done</reply>");
    await flush();
    expect(texts(id).at(-1)).toBe("chief: done");
  });
});

describe("inviting a bot not in the channel", () => {
  it("a bot suggests one of the user's other bots; Add puts it in", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, we need copy for the poster");
    await flush();
    expect(turns[0]!.prompt).toContain(
      "The user's other bots, not in this channel: Writer"
    );
    turns[0]!.resolve(
      '<reply>Writer should do this. <invite name="Writer">Copy is their job.</invite></reply>'
    );
    await flush();
    const card = store.readMessages(id)[1]!;
    expect(card).toMatchObject({
      text: "Writer should do this.",
      proposal: { invite: true, botId: "wri", status: "proposed" },
    });
    service.decideProposal(id, card.id, true);
    expect(service.thread(id).channel.memberBotIds).toEqual([
      "chief",
      "res",
      "wri",
    ]);
  });

  it("an invite for a member or an unknown name is dropped", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Chief, go");
    await flush();
    turns[0]!.resolve(
      '<reply>Sure <invite name="Researcher">x</invite></reply>'
    );
    await flush();
    service.post(id, "Chief, again");
    await flush();
    turns[1]!.resolve('<reply>Ok <invite name="Nobody">y</invite></reply>');
    await flush();
    expect(
      store.readMessages(id).filter((m) => m.proposal != null)
    ).toHaveLength(0);
  });
});

describe("a message to everyone", () => {
  it("without @everyone is answered in turn, with no summing-up", async () => {
    const run = async (text: string) => {
      const { service, turns, flush } = setup();
      const { id } = service.create({ botIds: ["chief", "wri"] });
      service.post(id, text);
      await flush();
      turns[0]!.resolve("<reply>Nova.</reply>");
      await flush();
      turns[1]!.resolve("<reply>Orbit.</reply>");
      await flush();
      return turns.length;
    };
    expect(await run("hi both, one line each")).toBe(2);
    expect(await run("@everyone, agree on a name")).toBe(3);
  });

  it("informing: every member keeps it in its notes", async () => {
    const { service, flush, noted } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"], name: "Launch" });
    service.post(id, "@everyone we launch on Friday");
    await flush();
    expect(noted).toEqual([
      'chief: [channel "Launch"] The user told everyone: @everyone we launch on Friday',
      'wri: [channel "Launch"] The user told everyone: @everyone we launch on Friday',
    ]);
  });

  it("allocating by name: the members it gives a part start it; the others start nothing", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(
      id,
      "@everyone: Writer drafts the launch post, Researcher checks cafe prices"
    );
    await flush();
    expect(turns[0]!.prompt).toContain("Start no work in this round");
    turns[0]!.resolve("<reply>I'll plan. <work>plan the launch</work></reply>");
    await flush();
    expect(turns[1]!.prompt).toContain("gives you a part by name");
    turns[1]!.resolve(
      "<reply>Checking. <work>check cafe prices</work></reply>"
    );
    await flush();
    turns[2]!.resolve(
      "<reply>Drafting. <work>draft the launch post</work></reply>"
    );
    await flush();
    expect(works.map((w) => w.botId)).toEqual(["res", "wri"]);
  });
});

describe("a deleted channel", () => {
  it("leaves each member a note that what it settled no longer applies", async () => {
    const { service, flush, noted } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"], name: "Launch" });
    service.post(id, "Decided: launch on Dec 19");
    await flush();
    service.remove(id);
    expect(noted.slice(-2)).toEqual([
      'chief: [channel "Launch"] This channel was deleted. What was decided or agreed in it no longer applies unless the user says so.',
      'wri: [channel "Launch"] This channel was deleted. What was decided or agreed in it no longer applies unless the user says so.',
    ]);
  });
});

describe("the channel's files folder", () => {
  it("is chosen once and kept when the channel is renamed", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"], name: "Brewly" });
    const folder = service.list()[0]!.folder!;
    expect(folder.startsWith("brewly-")).toBe(true);
    service.update(id, { name: "Brewly launch" });
    service.post(id, "Writer, write the post");
    await flush();
    turns[0]!.resolve("<reply>On it. <work>write the post</work></reply>");
    await flush();
    expect(works[0]!.prompt).toContain(
      `goes in the channel's folder "${folder}/"`
    );
  });
});

describe("a long work report", () => {
  it("is posted whole, not cut at a short answer's length", async () => {
    const { service, turns, works, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res"] });
    service.post(id, "Researcher, research the launch window");
    await flush();
    turns[0]!.resolve("<reply>On it. <work>research the window</work></reply>");
    await flush();
    const report = `${"Fact. ".repeat(1000)}Results: window.xlsx`;
    works[0]!.resolve(`<reply>${report}</reply>`);
    await flush();
    expect(texts(id).some((t) => t.includes("Results: window.xlsx"))).toBe(
      true
    );
  });
});

describe("summing up while work runs", () => {
  it("an Agreed: summing-up of work already under way is no plan to start", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Researcher, research the market");
    await flush();
    turns[0]!.resolve("<reply>On it. <work>research the market</work></reply>");
    await flush();
    expect(works).toHaveLength(1);
    service.post(id, "Chief, plan the launch post with Writer");
    await flush();
    turns[1]!.resolve("<reply>@Writer which day suits you?</reply>");
    await flush();
    turns[2]!.resolve("<reply>Friday.</reply>");
    await flush();
    expect(turns[3]!.prompt).toContain(
      'If work is already under way, say where it stands, without "Agreed:"'
    );
    turns[3]!.resolve(
      "<reply>Agreed:\n1. Research is running — Researcher\n2. Post on Friday — Writer</reply>"
    );
    await flush();
    const last = store.readMessages(id).at(-1)!;
    expect(last.text).toContain("Agreed:");
    expect(last.conclusion).toBeUndefined();
  });
});

describe("a hand-off chain", () => {
  const CHAIN =
    '<chain rounds="2"><step bot="Researcher">audit the repo</step><step bot="Writer">fix what Researcher found</step><step bot="Researcher">re-check the fixes</step></chain>';
  const start = async (
    words = "Researcher, audit the repo and have Writer fix what you find, then check again"
  ) => {
    const t = setup();
    const { id } = t.service.create({ botIds: ["chief", "res", "wri"] });
    t.service.post(id, words);
    await t.flush();
    t.turns[0]!.resolve(`<reply>On it, then Writer. ${CHAIN}</reply>`);
    await t.flush();
    return { ...t, id };
  };

  it("runs the steps in order, each in its bot's own chat with the report before it", async () => {
    const { works, flush, texts, id, store } = await start();
    // Step 1 only: the next waits for it.
    expect(works.map((w) => w.botId)).toEqual(["res"]);
    expect(works[0]!.prompt).toContain("step 1 of 5 of a hand-off chain");
    expect(works[0]!.prompt).toContain(
      "After you, step 2: Writer: fix what Researcher found"
    );
    works[0]!.resolve("<reply>Found 2 bugs: a and b.</reply>");
    await flush();
    expect(works.map((w) => w.botId)).toEqual(["res", "wri"]);
    expect(works[1]!.prompt).toContain("step 2 of 5");
    expect(works[1]!.prompt).toContain(
      "What step 1 reported (Researcher's words"
    );
    expect(works[1]!.prompt).toContain("Found 2 bugs: a and b.");
    // Each step is a card in the thread, labelled with its place.
    const cards = (store.threads.get(id) ?? []).filter((m) => m.work != null);
    expect(cards.map((m) => m.work?.chain?.step)).toEqual([1, 2]);
    expect(cards.every((m) => m.work?.chain?.of === 5)).toBe(true);
    expect(texts(id)).toContain("res: Found 2 bugs: a and b.");
  });

  it("a member whose step is still to come does not start its part early", async () => {
    const { works, flush, turns, service, id } = await start();
    expect(works.map((w) => w.botId)).toEqual(["res"]);
    service.post(id, "Writer, can you start fixing now?");
    await flush();
    expect(turns.at(-1)!.prompt).toContain(
      "Your part is step 2 of 5 of the hand-off running in this channel"
    );
    turns
      .at(-1)!
      .resolve("<reply>Starting the fixes. <work>fix the bugs</work></reply>");
    await flush();
    // Its step starts with the chain, not from this message.
    expect(works.map((w) => w.botId)).toEqual(["res"]);
  });

  it("the members a chain names by @ are not called to talk: they speak through their steps", async () => {
    const t = setup();
    const { id } = t.service.create({ botIds: ["chief", "res", "wri"] });
    t.service.post(
      id,
      "Researcher, audit the repo and have Writer fix what you find, then check again"
    );
    await t.flush();
    t.turns[0]!.resolve(`<reply>@Writer you fix after me. ${CHAIN}</reply>`);
    await t.flush();
    // Nobody else takes a turn: the chain's first step runs.
    expect(t.turns).toHaveLength(1);
    expect(t.works.map((w) => w.botId)).toEqual(["res"]);
  });

  it("the bot whose step is running does not start it a second time", async () => {
    const { works, flush, turns, service, id } = await start();
    service.post(id, "Researcher, how is the audit going?");
    await flush();
    expect(turns.at(-1)!.prompt).toContain("Your part is step 1 of 5");
    turns
      .at(-1)!
      .resolve("<reply>Starting it now. <work>audit the repo</work></reply>");
    await flush();
    expect(works.map((w) => w.botId)).toEqual(["res"]);
  });

  it("a new hand-off replaces the one running: the old takes no further step", async () => {
    const { works, flush, turns, service, id, store } = await start();
    service.post(
      id,
      "Researcher, change of plan: audit only the API and have Writer fix it"
    );
    await flush();
    turns
      .at(-1)!
      .resolve(
        '<reply>New plan. <chain rounds="1"><step bot="Researcher">audit the API</step><step bot="Writer">fix the API</step></chain></reply>'
      );
    await flush();
    // The old chain's step in flight is stopped, saying why.
    const oldCard = store
      .readMessages(id)
      .find(
        (m) => m.work?.chain?.step === 1 && m.work.task === "audit the repo"
      )!;
    expect(oldCard.work).toMatchObject({
      status: "stopped",
      error: "A newer hand-off replaced it.",
    });
    // Its step 2 never starts.
    works[0]!.resolve("<reply>Found a bug.</reply>");
    await flush();
    expect(
      works.some((w) => w.prompt.includes("Task: fix what Researcher found"))
    ).toBe(false);
  });

  it("a stop naming a bot not in the chain leaves the chain running", async () => {
    const { works, flush, turns, service, id } = await start();
    service.post(id, "Chief stop");
    await flush();
    turns.at(-1)!.resolve("<reply>Stopped.</reply>");
    await flush();
    works[0]!.resolve("<reply>Found a bug.</reply>");
    await flush();
    expect(works.map((w) => w.botId)).toEqual(["res", "wri"]);
  });

  it("hands the next step the whole turn, not only the closing line the thread shows", async () => {
    const { works, flush, texts, id } = await start();
    // As live: the findings in one message, then a closing line.
    works[0]!.resolve(
      "B1: add() subtracts.\nB2: average() divides by length - 1.\n␞\n<reply>The audit is done: findings above.</reply>"
    );
    await flush();
    expect(texts(id)).toContain("res: The audit is done: findings above.");
    expect(works[1]!.prompt).toContain("B1: add() subtracts.");
    expect(works[1]!.prompt).toContain("B2: average() divides by length - 1.");
  });

  it("ends when a check finds nothing left, and says so; the tag is never posted", async () => {
    const { works, flush, texts, id } = await start();
    works[0]!.resolve("<reply>Found a bug.</reply>");
    await flush();
    works[1]!.resolve("<reply>Fixed it.</reply>");
    await flush();
    works[2]!.resolve("<reply>All clean now. <chain_done/></reply>");
    await flush();
    expect(works).toHaveLength(3);
    const last = texts(id).at(-1)!;
    expect(last).toContain("All clean now.");
    expect(last).toContain("the hand-off ends here (step 3 of 5)");
    expect(last).not.toContain("chain_done");
  });

  it("ends at a step that fails, and Stop ends it before the next step", async () => {
    const failed = await start();
    failed.works[0]!.reject(new Error("no access to the repo"));
    await failed.flush();
    expect(failed.works).toHaveLength(1);

    const stopped = await start();
    stopped.works[0]!.resolve("<reply>Found a bug.</reply>");
    await stopped.flush();
    expect(stopped.works).toHaveLength(2);
    stopped.service.stop(stopped.id);
    await stopped.flush();
    expect(stopped.works).toHaveLength(2);
  });

  it("is not run when the user did not name a bot in it", async () => {
    const { works, texts, id } = await start("Researcher, audit the repo");
    expect(works).toHaveLength(0);
    // The words are posted, not the tag, and they say the hand-off did not start.
    const last = texts(id).find((t) =>
      t.startsWith("res: On it, then Writer.")
    )!;
    expect(last).toContain(
      "The hand-off did not start: you have not named Writer in this channel."
    );
    expect(last).not.toContain("<chain");
  });
});

describe("a team that keeps going (the user named the members once)", () => {
  it("a member the user named in the channel, brought in by another, takes the work on", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Chief, you manage; the copy is the job of Writer.");
    await flush();
    turns[0]!.resolve("<reply>@Writer write the launch email</reply>");
    await flush();
    expect(turns[1]!.botId).toBe("wri");
    expect(turns[1]!.prompt).toContain("The user named you in this channel");
    turns[1]!.resolve(
      "<reply>Writing it. <work>Write the launch email as launch.md</work></reply>"
    );
    await flush();
    expect(works.map((work) => work.botId)).toEqual(["wri"]);
  });

  it("a chain may use members the user named in an earlier message", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(
      id,
      "Chief, you lead; the research is for Researcher and the writing for Writer."
    );
    await flush();
    turns[0]!.resolve("<reply>Ready.</reply>");
    await flush();
    service.post(id, "Chief, nothing is happening, get it done");
    await flush();
    expect(turns[1]!.botId).toBe("chief");
    turns[1]!.resolve(
      '<reply>Running it. <chain><step bot="Researcher">Research Brewly\'s rivals</step><step bot="Writer">Write the brief from the research</step></chain></reply>'
    );
    await flush();
    expect(works.map((work) => work.botId)).toEqual(["res"]);
  });

  it("a reply that says work is happening but started none is asked once to start it", async () => {
    const { service, turns, works, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Writer, build the landing page");
    await flush();
    turns[0]!.resolve("<reply>Building it now, will post the link.</reply>");
    await flush();
    expect(turns[1]!.botId).toBe("wri");
    expect(turns[1]!.prompt).toContain("you started nothing");
    turns[1]!.resolve(
      "<reply>Starting it. <work>Build the landing page as index.html</work></reply>"
    );
    await flush();
    expect(works.map((work) => work.botId)).toEqual(["wri"]);
    expect(texts(id).at(-1)).toBe("wri: Starting it.");
  });

  it("a member the lead @names after a report answers it", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(
      id,
      "@Chief find the options and pass the list to @Writer to pick one"
    );
    await flush();
    turns[0]!.resolve("<reply>On it. <work>Find the options</work></reply>");
    await flush();
    turns[1]!.resolve("<reply>Waiting on Chief's list.</reply>");
    await flush();
    works[0]!.resolve("<reply>Ten options, ranked.</reply>");
    await flush();
    expect(turns[2]!.botId).toBe("chief");
    turns[2]!.resolve("<reply>@Writer the list is above: pick one.</reply>");
    await flush();
    expect(turns[3]!.botId).toBe("wri");
    expect(turns[3]!.prompt).toContain("Chief @named you above");
    turns[3]!.resolve("<reply>Option 2.</reply>");
    await flush();
    // A report turn's floor gets no summing-up.
    expect(turns).toHaveLength(4);
  });

  it("failed work wakes the lead, which sees why", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "@Writer write the launch email");
    await flush();
    turns[0]!.resolve(
      "<reply>On it. <work>Write the launch email</work></reply>"
    );
    await flush();
    works[0]!.reject(new Error("its turn ended without a report."));
    await flush();
    expect(turns[1]!.botId).toBe("chief");
    expect(turns[1]!.prompt).toContain(
      "This work: failed: its turn ended without a report."
    );
  });

  it("work the user stopped in the bot's own chat shows stopped and wakes nobody", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "@Writer write the launch email");
    await flush();
    turns[0]!.resolve(
      "<reply>On it. <work>Write the launch email</work></reply>"
    );
    await flush();
    works[0]!.reject(
      new TurnStoppedError("it was stopped partway, so it may be half done.")
    );
    await flush();
    const card = (store.threads.get(id) ?? []).find((m) => m.work != null);
    expect(card?.work?.status).toBe("stopped");
    expect(turns).toHaveLength(1);
  });

  it("a report that waited on work stopped in its own chat still wakes the lead", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "@Writer write the email, @Researcher check prices");
    await flush();
    turns[0]!.resolve("<reply>On it. <work>write the email</work></reply>");
    await flush();
    turns[1]!.resolve("<reply>On it. <work>check prices</work></reply>");
    await flush();
    works[1]!.resolve("<reply>Prices checked.</reply>");
    await flush();
    const before = turns.length;
    works[0]!.reject(
      new TurnStoppedError("it was stopped partway, so it may be half done.")
    );
    await flush();
    expect(turns.length).toBe(before + 1);
  });

  it("a hand-off step stopped in its bot's own chat ends the hand-off and wakes nobody", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(
      id,
      "Researcher, audit the repo and have Writer fix what you find"
    );
    await flush();
    turns[0]!.resolve(
      '<reply>On it. <chain><step bot="Researcher">audit the repo</step><step bot="Writer">fix it</step></chain></reply>'
    );
    await flush();
    works[0]!.reject(new TurnStoppedError("it was stopped partway."));
    await flush();
    expect(works).toHaveLength(1);
    expect(turns).toHaveLength(1);
    expect(service.list().find((c) => c.id === id)?.working).toEqual([]);
  });

  it("a user message sent while a lead turn waits is answered once, by its own round", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "@Writer write the launch email");
    await flush();
    turns[0]!.resolve(
      "<reply>On it. <work>Write the launch email</work></reply>"
    );
    await flush();
    // Chief is answering a question when Writer's work ends: the lead's
    // report turn queues behind that round. Then the user writes again.
    service.post(id, "@Chief which day do we launch?");
    await flush();
    works[0]!.resolve("Here is the email.");
    await flush();
    service.post(id, "@Chief and what's the plan for tomorrow?");
    turns[1]!.resolve("<reply>Friday.</reply>");
    await flush();
    // The user's newest message is answered by its own round, not by the
    // report turn first (which would answer it, then be answered again).
    expect(turns).toHaveLength(3);
    expect(turns[2]!.prompt).toContain("Answer the user's latest message.");
    expect(turns[2]!.prompt).not.toContain("work just ended");
  });

  it("a report that waited on other work wakes the lead when that work fails", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Chief, Researcher and Writer: do your part");
    await flush();
    await answerInTurn(turns, flush, [
      "<reply>Ready.</reply>",
      "<reply>Research. <work>Research it</work></reply>",
      "<reply>Write. <work>Write it</work></reply>",
    ]);
    works[0]!.resolve("<reply>Researched.</reply>");
    await flush();
    expect(turns).toHaveLength(3);
    works[1]!.reject(
      new Error("it took more than 30 minutes, so it was stopped.")
    );
    await flush();
    expect(turns[3]!.botId).toBe("chief");
  });

  it("the lead is woken only when the last running work reports, and at most MAX_LEAD_TURNS times per user message", async () => {
    const { service, turns, works, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Chief, Researcher and Writer: do your part");
    await flush();
    await answerInTurn(turns, flush, [
      "<reply>Plan. <work>Plan it</work></reply>",
      "<reply>Research. <work>Research it</work></reply>",
      "<reply>Write. <work>Write it</work></reply>",
    ]);
    expect(works).toHaveLength(3);
    works[0]!.resolve("<reply>Planned.</reply>");
    works[1]!.resolve("<reply>Researched.</reply>");
    await flush();
    // Writer is still working: no lead turn yet.
    expect(turns).toHaveLength(3);
    works[2]!.resolve("<reply>Written.</reply>");
    await flush();
    expect(turns).toHaveLength(4);
    expect(turns[3]!.botId).toBe("chief");
    // The lead keeps going: each of its own reports wakes it again, up to the bound.
    let at = 3;
    for (let i = 1; i < MAX_LEAD_TURNS; i++) {
      turns[at]!.resolve(`<reply>Next. <work>Step ${i}</work></reply>`);
      await flush();
      works.at(-1)!.resolve(`<reply>Step ${i} done.</reply>`);
      await flush();
      at += 1;
      expect(turns[at]!.botId).toBe("chief");
    }
    turns[at]!.resolve("<reply>Next. <work>One more</work></reply>");
    await flush();
    works.at(-1)!.resolve("<reply>One more done.</reply>");
    await flush();
    expect(turns).toHaveLength(at + 1);
  });
});
