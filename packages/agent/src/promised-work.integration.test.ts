/**
 * A turn that ends on a promise, through the real loops and a scripted model.
 *
 * Both loops: the closing words go to the judge (its endpoint answered here),
 * and on "now" the model is told once, inside the send, so the run stays open
 * and the turn ends once. The ask is a budget of one per user message: nothing
 * a continuation does may hand it back. A judge that fails asks nothing.
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
  vi,
} from "vitest";

import { abacusV1BaseUrl } from "./abacus-endpoint.js";
import { resetBackgroundJobs } from "./background-processes.js";
import { BotSession } from "./bot/bot-session.js";
import { noteCreditsBack, noteCreditWall } from "./credit-wall.js";
import { PROMISED_WORK_PROMPT, TURN_END_JUDGE_MODEL } from "./promised-work.js";
import { AgentStatus, type DesktopEvent } from "./protocol.js";
import { AbacusBotSession } from "./session.js";

const PROMISE = "Three files changed so far. Reading the rest now.";
const DONE = "All of it is read: nothing else needs changing.";
const READ_CALL = { name: "ls", args: { path: "." } };

let provider: FakeProvider;
let home: string;

/** The judge's answer to each request it gets; the closing words it was shown are recorded. */
let judge: (shown: string, signal?: AbortSignal | null) => Promise<Response>;
let judged: string[] = [];
const letter = (answer: string): Promise<Response> =>
  Promise.resolve(
    Response.json({ choices: [{ message: { content: answer } }] })
  );
/** The scripted judge: the promise and nothing else reads as going on now. */
const judgeByWords = (shown: string): Promise<Response> =>
  letter(shown.includes(PROMISE) ? "A" : "B");
const realFetch = globalThis.fetch;

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
  process.env.ABACUS_API_KEY = ["judge", "test", "key"].join("-");
  provider.calls.length = 0;
  judged = [];
  judge = judgeByWords;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as {
            model?: string;
            messages?: Array<{ content: string }>;
          })
        : {};
    if (
      !url.startsWith(abacusV1BaseUrl()) ||
      body.model !== TURN_END_JUDGE_MODEL
    )
      return realFetch(input, init);
    const shown = body.messages?.[0]?.content ?? "";
    judged.push(shown);
    return judge(shown, init?.signal);
  });
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_AUDIENCE;
  delete process.env.ABACUS_API_KEY;
  vi.restoreAllMocks();
  resetBackgroundJobs();
});

type Loop = {
  start(): Promise<void>;
  send(text: string, turn?: { messageId?: string }): Promise<void>;
  steer(text: string, messageId?: string): Promise<void>;
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

/** Turns that ended with an outcome: one per send. */
const turnEnds = (events: DesktopEvent[]): unknown[] =>
  agentEvents(events, "turn_complete").filter(
    (event) => (event as { outcome?: unknown }).outcome != null
  );

/** A judge that answers only when released, or never; it gives up when its call is cut off. */
const heldJudge = () => {
  let release: ((answer: string) => void) | undefined;
  const answer = new Promise<string>((resolve) => {
    release = resolve;
  });
  return {
    judge: (_shown: string, signal?: AbortSignal | null) =>
      new Promise<Response>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        void answer.then((letterAnswer) =>
          resolve(
            Response.json({ choices: [{ message: { content: letterAnswer } }] })
          )
        );
      }),
    release: (answerLetter: string) => release?.(answerLetter),
  };
};

const until = async (check: () => boolean): Promise<void> => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
};

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

  it("judges after the reply, with the user's words and the closing words", async () => {
    scripted([{ say: PROMISE }, { say: "", call: READ_CALL }, { say: DONE }]);
    const { loop } = await start(Loop);
    await loop.send("read the files");

    // The promise and the closing answer; the ask is spent, so DONE is judged by no one.
    expect(judged).toHaveLength(1);
    expect(judged[0]).toContain("The user asked: read the files");
    expect(judged[0]).toContain(PROMISE);
    // The judge never touches the session's prompt: its prefix is the same on every request.
    const systems = provider.calls.map(
      (call) =>
        call.messages.find((message) => message.role === "system")?.content
    );
    expect(new Set(systems.map((system) => JSON.stringify(system))).size).toBe(
      1
    );
  });

  it("asks on a closing no word list named, when the judge reads it as going on", async () => {
    judge = () => letter("A");
    scripted([
      { say: "Section one is in. Moving into the headers next." },
      { say: "", call: READ_CALL },
      { say: DONE },
    ]);
    const { loop } = await start(Loop);
    await loop.send("fix the document");

    expect(asks()).toBe(1);
    expect(provider.calls).toHaveLength(3);
  });

  it.each([
    ["an error", () => Promise.resolve(new Response("down", { status: 500 }))],
    ["an answer it cannot read", () => letter("maybe")],
    ["a later promise", () => letter("C")],
    [
      "a timeout",
      // Never answers: only the judge's own timeout ends it.
      (_shown: string, signal?: AbortSignal | null) =>
        new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason))
        ),
    ],
  ])("asks nothing when the judge gives %s", async (_kind, answer) => {
    judge = answer;
    scripted([{ say: PROMISE }]);
    const { loop, events } = await start(Loop);
    await loop.send("read the files");

    expect(judged).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(agentEvents(events, "promised_work_recovery")).toHaveLength(0);
    expect(turnEnds(events)).toHaveLength(1);
  });

  it("sends a chat's reply before the verdict, and owes nothing more when there is no steer", async () => {
    const held = heldJudge();
    judge = held.judge;
    scripted([{ say: PROMISE }]);
    const { loop, events } = await start(Loop);
    const turn = loop.send("read the files", { messageId: "m1" });
    await until(() => judged.length === 1);
    await until(() => agentEvents(events, "turn_answer").length === 1);

    expect(agentEvents(events, "turn_answer")[0]).toMatchObject({
      messageIds: ["m1"],
      text: PROMISE,
      settled: true,
    });
    expect(turnEnds(events)).toHaveLength(0);
    held.release("B");
    await turn;
    expect(turnEnds(events)).toHaveLength(1);
  });

  it("lands a Stop at once while the verdict is pending", async () => {
    const held = heldJudge();
    judge = held.judge;
    scripted([{ say: PROMISE }]);
    const { loop, events } = await start(Loop);
    const turn = loop.send("read the files");
    await until(() => judged.length === 1);
    const stopped = Date.now();
    await loop.stop();
    await turn;

    expect(Date.now() - stopped).toBeLessThan(1_500);
    expect(asks()).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect(turnEnds(events)).toHaveLength(1);
  });

  it("answers a message the user sent meanwhile instead of steering", async () => {
    const held = heldJudge();
    judge = held.judge;
    scripted([{ say: PROMISE }]);
    const { loop, events } = await start(Loop);
    const turn = loop.send("read the files");
    await until(() => judged.length === 1);
    await loop.steer("never mind, stop there");
    held.release("A");
    await turn;

    expect(agentEvents(events, "promised_work_recovery")).toHaveLength(0);
    expect(
      provider.calls.some((call) =>
        call.userText.some((text) => text.includes(PROMISED_WORK_PROMPT))
      )
    ).toBe(false);
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
