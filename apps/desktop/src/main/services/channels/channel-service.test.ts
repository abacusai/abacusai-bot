/**
 * ChannelService: the user's message is posted at once and answered by the
 * bots the rules pick, one message at a time per channel; a bot's @mention
 * brings another member in once and the first bot then finishes; @everyone
 * answers each on its own; Stop ends the round and drops what waits.
 */
import type { ChannelMessage } from "@abacus-ai/contract/channels";
import { describe, expect, it, vi } from "vitest";

import {
  type ChannelDeps,
  ChannelService,
  type ChannelStore,
  type StoredChannel,
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
  const works: Array<(typeof turns)[number] & { workId: string }> = [];
  const noted: string[] = [];
  let n = 0;
  const service = new ChannelService({
    store,
    bot: (id) => BOTS[id] ?? null,
    runTurn: (botId, _channel, prompt) =>
      new Promise((resolve, reject) =>
        turns.push({ botId, prompt, resolve, reject })
      ),
    runWork: (botId, _channel, prompt, workId) =>
      new Promise((resolve, reject) =>
        works.push({ botId, prompt, resolve, reject, workId })
      ),
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
  return { service, store, turns, works, flush, texts, noted };
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

  it("an @mention brings the other bot in once, then the first finishes", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Chief, plan the launch");
    await flush();
    turns[0]!.resolve("<reply>@Researcher who are our competitors?</reply>");
    await flush();
    expect(turns[1]?.botId).toBe("res");
    expect(turns[1]?.prompt).toContain("Chief brought you in");
    expect(turns[1]?.prompt).toContain("@Researcher who are our competitors?");
    // The brought-in bot's own @mention calls nobody.
    turns[1]!.resolve(
      "<reply>Blue Tokai and Starbucks. @Writer could use this.</reply>"
    );
    await flush();
    expect(turns[2]?.botId).toBe("chief");
    expect(turns[2]?.prompt).toContain("Researcher answered your request");
    turns[2]!.resolve("<reply>Plan: undercut Blue Tokai.</reply>");
    await flush();
    expect(turns).toHaveLength(3);
    expect(texts(id).slice(1)).toEqual([
      "chief: @Researcher who are our competitors?",
      "res: Blue Tokai and Starbucks. @Writer could use this.",
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

  it("@everyone answers in parallel, none seeing the others", async () => {
    const { service, turns, flush, texts } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "@everyone biggest risk?");
    await flush();
    expect(turns.map((t) => t.botId)).toEqual(["chief", "res", "wri"]);
    turns[1]!.resolve("<reply>Price.</reply>");
    await flush();
    turns[0]!.resolve("<reply>Timing.</reply>");
    turns[2]!.resolve("<reply>Copy.</reply>");
    await flush();
    expect(turns.every((t) => !t.prompt.includes("Price."))).toBe(true);
    expect(texts(id)).toHaveLength(4);
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

  it("a deleted bot leaves its channels", () => {
    const { service } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.forgetBot("wri");
    expect(service.thread(id).channel.memberBotIds).toEqual(["chief", "res"]);
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
    expect(works[0]!.prompt).toContain(
      'The user\'s own words, verbatim: "Writer, write the launch email as a doc"'
    );
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
    expect(service.list()[0]?.working).toEqual([]);
  });

  it("a bot brought in cannot take work on; one answering @everyone can", async () => {
    const { service, turns, works, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "wri"] });
    service.post(id, "Chief, get Writer to save the email");
    await flush();
    turns[0]!.resolve("<reply>@Writer save it</reply>");
    await flush();
    expect(turns[1]!.prompt).toContain("You can't take work");
    turns[1]!.resolve("<reply>I would <work>save the email</work></reply>");
    await flush();
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
    turns[4]!.resolve("<reply>Ok</reply>");
    await flush();
    expect(works.map((work) => work.botId)).toEqual(["chief"]);
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
    expect(store.threads.get(id)![1]!.work?.status).toBe("stopped");
    service.post(id, "Researcher, find prices");
    await flush();
    turns[1]!.resolve("<reply><work>Find prices</work></reply>");
    await flush();
    service.forgetBot("res");
    expect(store.threads.get(id)![3]!.work?.status).toBe("stopped");
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

describe("team discussions", () => {
  it("everyone speaks in turn seeing the others, until a round adds nothing; then the lead sums up", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Ideate together and agree on three launch ideas");
    const say = async (index: number, raw: string) => {
      await flush();
      turns[index]!.resolve(raw);
      await flush();
    };
    // Round 1: all three in member order, each seeing the ones before.
    await say(0, "<reply>chief idea</reply>");
    await say(1, "<reply>res idea</reply>");
    await say(2, "<reply>wri idea</reply>");
    expect(turns.slice(0, 3).map((t) => t.botId)).toEqual([
      "chief",
      "res",
      "wri",
    ]);
    expect(turns[0]!.prompt).toContain("round 1 of at most 3");
    expect(turns[1]!.prompt).toContain("chief idea");
    // Round 2: two react, one passes.
    expect(turns[3]!.prompt).toContain("round 2 of at most 3");
    await say(3, "<reply>@Writer yours is cheaper</reply>");
    await say(4, "<reply>NO_REPLY</reply>");
    await say(5, "<reply>Agree with Chief</reply>");
    // Round 3: nobody adds anything, so the lead sums up.
    await say(6, "<reply>NO_REPLY</reply>");
    await say(7, "<reply>NO_REPLY</reply>");
    await say(8, "<reply>NO_REPLY</reply>");
    expect(turns[9]!.botId).toBe("chief");
    expect(turns[9]!.prompt).toContain('start with "Agreed:"');
    await say(9, "<reply>Agreed:\n1. A\n2. B\n3. C</reply>");
    expect(turns).toHaveLength(10);
    expect(store.threads.get(id)!.at(-1)).toMatchObject({
      conclusion: true,
      text: "Agreed:\n1. A\n2. B\n3. C",
    });
    expect(store.threads.get(id)).toHaveLength(1 + 3 + 2 + 1);
  });

  it("ends early when a round adds nothing, and Stop ends it at once", async () => {
    const { service, turns, flush } = setup();
    const { id } = service.create({ botIds: ["chief", "res", "wri"] });
    service.post(id, "Discuss whether we should launch on Dec 19");
    await flush();
    turns[0]!.resolve("<reply>Yes</reply>");
    await flush();
    service.stop(id);
    await flush();
    expect(turns).toHaveLength(2);
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

describe("the user speaks during a discussion", () => {
  it("ends the debate after the current turn; the lead sums up; then the message is answered once", async () => {
    const { service, turns, flush, store } = setup();
    const { id } = service.create({
      botIds: ["chief", "res", "wri"],
      text: "discuss and agree on a launch price",
    });
    await flush();
    turns[0]!.resolve("<reply>₹120.</reply>");
    await flush();
    service.post(id, "must be under ₹100");
    turns[1]!.resolve("<reply>₹150.</reply>");
    await flush();
    // Nobody else debates; the lead concludes, shown nothing past the trigger.
    expect(turns[2]!.botId).toBe("chief");
    expect(turns[2]!.prompt).toContain("discussion above is over");
    expect(turns[2]!.prompt).not.toContain("under ₹100");
    turns[2]!.resolve("<reply>Agreed: 1. ₹120–150.</reply>");
    await flush();
    // Then the user's message, once, by the last speaker, with everything in view.
    expect(turns[3]!.botId).toBe("chief");
    expect(turns[3]!.prompt).toContain("under ₹100");
    turns[3]!.resolve("<reply>Under ₹100 then.</reply>");
    await flush();
    expect(turns).toHaveLength(4);
    const bots = store.threads.get(id)!.filter((m) => m.author.kind === "bot");
    expect(bots.map((m) => m.text)).toEqual([
      "₹120.",
      "₹150.",
      "Agreed: 1. ₹120–150.",
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

  it("the lead's summary of a discussion, to every member", async () => {
    const { service, turns, flush, noted } = setup();
    const { id } = service.create({
      botIds: ["chief", "res", "wri"],
      name: "Launch",
      text: "discuss and agree on a price",
    });
    await flush();
    for (let i = 0; i < 3; i++) {
      turns[i]!.resolve("<reply>₹99.</reply>");
      await flush();
    }
    for (let i = 3; i < 6; i++) {
      turns[i]!.resolve("<reply>NO_REPLY</reply>");
      await flush();
    }
    turns[6]!.resolve("<reply>**Agreed:** 1. ₹99 (Chief)</reply>");
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
    for (let i = 0; i < 3; i++) {
      turns[i]!.resolve("<reply>A task each.</reply>");
      await flush();
    }
    for (let i = 3; i < 6; i++) {
      turns[i]!.resolve("<reply>NO_REPLY</reply>");
      await flush();
    }
    turns[6]!.resolve(
      "<reply>Agreed:\n1. Researcher lists the suppliers.\n2. Writer drafts the sign.</reply>"
    );
    await flush();
    service.post(id, "yes, go ahead");
    await flush();
    expect(works.map((work) => work.botId)).toEqual(["res", "wri"]);
    expect(store.readMessages(id).find((m) => m.conclusion)?.planStarted).toBe(
      true
    );
    expect(turns).toHaveLength(7);
    // Once started, a second yes is an ordinary message (here: a plain
    // acknowledgement nobody answers), and starts nothing again.
    service.post(id, "yes");
    await flush();
    expect(works).toHaveLength(2);
    expect(turns).toHaveLength(7);
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
