/**
 * A turn that ends on a promise, through the real loops and a scripted model.
 *
 * Both loops: the model is told once, inside the send, so the run stays open and
 * the turn ends once. The ask is a budget of one per user message: nothing a
 * continuation does may hand it back.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { resetBackgroundJobs } from "./background-processes.js";
import { BotSession } from "./bot/bot-session.js";
import { noteCreditsBack, noteCreditWall } from "./credit-wall.js";
import { PROMISED_WORK_PROMPT } from "./promised-work.js";
import { AgentStatus, type DesktopEvent } from "./protocol.js";
import { AbacusBotSession } from "./session.js";

const PROMISE = "Three files changed so far. Reading the rest now.";
const DONE = "All of it is read: nothing else needs changing.";
const READ_CALL = { name: "ls", args: { path: "." } };

let provider: FakeProvider;
let home: string;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "promised-work-home-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = path.join(home, "bot");
  fs.mkdirSync(path.join(home, "bot"));
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider)
  );
});

afterAll(async () => {
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.ABACUSAI_BOT_AUDIENCE = "owner";
  provider.calls.length = 0;
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_AUDIENCE;
  resetBackgroundJobs();
});

type Loop = {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  dispose?(): void;
};

const LOOPS: Array<[string, new (options: never) => Loop]> = [
  ["the session loop", AbacusBotSession as never],
  ["the bot loop", BotSession as never],
];

const start = async (
  Loop: new (options: never) => Loop,
  mode = "yolo"
): Promise<{ loop: Loop; events: DesktopEvent[] }> => {
  const events: DesktopEvent[] = [];
  const loop = new Loop({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "promised-work-cwd-")),
    mode,
    hostServices: false,
    emit: (event: DesktopEvent) => events.push(event),
  } as never);
  await loop.start();
  return { loop, events };
};

const agentEvents = (events: DesktopEvent[], type: string): unknown[] =>
  events.flatMap((event) =>
    event.type === "event" && event.event.type === type ? [event.event] : []
  );

/** Asks the last request carries in its history. */
const asks = (): number =>
  (provider.calls.at(-1)?.userText ?? []).filter((text) =>
    text.includes(PROMISED_WORK_PROMPT)
  ).length;

/** The model's replies in order, the last repeated. */
const scripted = (replies: Reply[]): void => {
  provider.script(
    (_call, index) => replies[Math.min(index, replies.length - 1)]!
  );
};

describe.each(LOOPS)("%s", (_name, Loop) => {
  it("asks once, inside the same turn, and the work lands in it", async () => {
    scripted([{ say: PROMISE }, { say: "", call: READ_CALL }, { say: DONE }]);
    const { loop, events } = await start(Loop);
    await loop.send("read the files");

    expect(provider.calls).toHaveLength(3);
    expect(asks()).toBe(1);
    expect(agentEvents(events, "promised_work_recovery")).toHaveLength(1);
    // One end: the run stayed open through the ask.
    const ends = agentEvents(events, "turn_complete").filter(
      (event) => (event as { outcome?: unknown }).outcome != null
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: { kind: "reply" } });
    const idles = agentEvents(events, "status_changed").filter(
      (event) => (event as { status: string }).status === AgentStatus.Idle
    );
    expect(idles.length).toBeLessThanOrEqual(2);
  });

  it("holds the cap when the model promises again and again", async () => {
    scripted([{ say: PROMISE }]);
    const { loop } = await start(Loop);
    await loop.send("read the files");

    expect(provider.calls).toHaveLength(2);
    expect(asks()).toBe(1);
  });

  it("holds the cap across tool rounds in the continuation", async () => {
    scripted([
      { say: PROMISE },
      { say: "", call: READ_CALL },
      { say: PROMISE },
      { say: DONE },
    ]);
    const { loop } = await start(Loop);
    await loop.send("read the files");

    expect(asks()).toBe(1);
    expect(provider.calls).toHaveLength(3);
  });

  it("gives a new user message a new ask", async () => {
    scripted([{ say: PROMISE }]);
    const { loop } = await start(Loop);
    await loop.send("read the files");
    await loop.send("and the others");

    expect(asks()).toBe(2);
  });

  it.each([
    ["a question", "I found three. Should I read the rest now?"],
    ["a hand-back", "Say go and I'll read the rest."],
    [
      "a finished answer",
      "All three files are read, and nothing needs changing.",
    ],
  ])("leaves %s alone", async (_kind, say) => {
    scripted([{ say }]);
    const { loop } = await start(Loop);
    await loop.send("read the files");

    expect(provider.calls).toHaveLength(1);
  });

  it("never asks on a routine, a contact's chat or a plan", async () => {
    scripted([{ say: PROMISE }]);
    const routine = await start(Loop, "unattended");
    await routine.loop.send("the routine's prompt");
    expect(provider.calls).toHaveLength(1);

    provider.calls.length = 0;
    const plan = await start(Loop, "plan");
    await plan.loop.send("plan it");
    expect(provider.calls).toHaveLength(1);

    provider.calls.length = 0;
    delete process.env.ABACUSAI_BOT_AUDIENCE;
    const contact = await start(Loop);
    await contact.loop.send("hello");
    expect(provider.calls).toHaveLength(1);
  });

  it("does not ask after Stop", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.script(async () => {
      await held;
      return { say: PROMISE };
    });
    const { loop } = await start(Loop);
    const turn = loop.send("read the files");
    while (provider.calls.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.stop();
    release?.();
    await turn;

    expect(asks()).toBe(0);
  });

  it("does not ask at the credit wall", async () => {
    scripted([{ say: PROMISE }]);
    const { loop } = await start(Loop);
    noteCreditWall();
    try {
      await loop.send("read the files");
    } finally {
      noteCreditsBack();
    }

    expect(asks()).toBe(0);
  });
});

it("does not ask while a background job can still wake the run", async () => {
  scripted([
    { call: { name: "bash", args: { command: "sleep 5", background: true } } },
    { say: PROMISE },
  ]);
  const { loop } = await start(AbacusBotSession as never);
  await loop.send("run it in the background");

  expect(asks()).toBe(0);
  expect(provider.calls).toHaveLength(2);
});
