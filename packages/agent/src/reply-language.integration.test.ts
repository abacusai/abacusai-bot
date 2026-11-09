/**
 * The reply-language check at a turn's end, through both real loops and a
 * scripted model: a reply in another script is asked for again, and a
 * romanized candidate the check lets stand still ends the turn once, with
 * what follows a clean run (the next-step ask) intact.
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
import { NEXT_STEP_PROMPT } from "./next-step-ask.js";
import { AgentStatus, type DesktopEvent } from "./protocol.js";
import { AbacusBotSession } from "./session.js";

const BENGALI_TYPED_IN_LATIN = "amar kalker meeting kokhon ache bolo to ektu";
const BENGALI_REPLY =
  "আপনার আগামীকালের মিটিং সকাল দশটায়, তারপরেই একটা কল আছে। নোটে লিখে রেখেছি।";
const URDU_QUESTION = "کیا آپ مجھے کل کی میٹنگ کے بارے میں بتا سکتے ہیں";
const ENGLISH_REPLY =
  "Yes, tomorrow at ten you have the team meeting, and a call right after it.";
const URDU_REPLY =
  "جی ہاں، کل صبح دس بجے آپ کی ٹیم کے ساتھ میٹنگ ہے اور اس کے بعد ایک کال ہے۔";
const REPAIR = "Write that reply again now";

let provider: FakeProvider;
let home: string;
const savedKey = process.env.ABACUS_API_KEY;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "reply-language-home-"));
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
  if (savedKey != null) process.env.ABACUS_API_KEY = savedKey;
});

beforeEach(() => {
  // No key: no detection call leaves the machine, and the check has no answer.
  delete process.env.ABACUS_API_KEY;
  process.env.ABACUSAI_BOT_AUDIENCE = "owner";
  provider.calls.length = 0;
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_AUDIENCE;
  delete process.env.ABACUSAI_BOT_NEXT_STEP_ASK;
  fs.rmSync(path.join(home, "user-language.json"), { force: true });
  resetBackgroundJobs();
});

type Loop = { start(): Promise<void>; send(text: string): Promise<void> };

const LOOPS: Array<[string, new (options: never) => Loop]> = [
  ["the session loop", AbacusBotSession as never],
  ["the bot loop", BotSession as never],
];

const start = async (
  Loop: new (options: never) => Loop
): Promise<{ loop: Loop; events: DesktopEvent[] }> => {
  const events: DesktopEvent[] = [];
  const loop = new Loop({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "reply-language-cwd-")),
    mode: "yolo",
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

const ends = (events: DesktopEvent[]): unknown[] =>
  agentEvents(events, "turn_complete").filter(
    (event) => (event as { outcome?: unknown }).outcome != null
  );

const idle = (events: DesktopEvent[]): boolean =>
  agentEvents(events, "status_changed").some(
    (event) => (event as { status: string }).status === AgentStatus.Idle
  );

/** Whether a request carried this text as a user turn. */
const asked = (text: string): number =>
  provider.calls.filter((call) => (call.userText.at(-1) ?? "").includes(text))
    .length;

const scripted = (pick: (last: string, index: number) => Reply): void => {
  provider.script((call, index) => pick(call.userText.at(-1) ?? "", index));
};

describe.each(LOOPS)("%s", (_name, Loop) => {
  it("asks once for a Latin reply to words in another script, and ends the turn once", async () => {
    scripted((last) =>
      last.includes(REPAIR) ? { say: URDU_REPLY } : { say: ENGLISH_REPLY }
    );
    const { loop, events } = await start(Loop);
    await loop.send(URDU_QUESTION);

    expect(asked(REPAIR)).toBe(1);
    expect(provider.calls).toHaveLength(2);
    expect(ends(events)).toHaveLength(1);
    expect(idle(events)).toBe(true);
  });

  it("lets a romanized candidate stand and still ends the turn once", async () => {
    scripted(() => ({ say: BENGALI_REPLY }));
    const { loop, events } = await start(Loop);
    await loop.send(BENGALI_TYPED_IN_LATIN);

    expect(asked(REPAIR)).toBe(0);
    expect(provider.calls).toHaveLength(1);
    expect(ends(events)).toHaveLength(1);
    expect(idle(events)).toBe(true);
  });

  it("keeps the next-step ask after a candidate it lets stand", async () => {
    process.env.ABACUSAI_BOT_NEXT_STEP_ASK = "1";
    scripted((last, index) =>
      last.includes(NEXT_STEP_PROMPT.slice(0, 40))
        ? { say: "আর কিছু লাগবে?" }
        : index === 0
          ? {
              say: "",
              call: {
                name: "write",
                args: { path: "meeting.md", content: "10:00 meeting" },
              },
            }
          : { say: BENGALI_REPLY }
    );
    const { loop, events } = await start(Loop);
    await loop.send(BENGALI_TYPED_IN_LATIN);

    expect(asked(REPAIR)).toBe(0);
    expect(asked(NEXT_STEP_PROMPT.slice(0, 40))).toBe(1);
    expect(ends(events)).toHaveLength(1);
    expect(idle(events)).toBe(true);
  });

  it("asks again when the saved language says the reply's script is not theirs", async () => {
    fs.writeFileSync(
      path.join(home, "user-language.json"),
      JSON.stringify({
        language: { name: "Urdu", source: "detected" },
        version: 2,
      })
    );
    scripted((last) =>
      last.includes(REPAIR) ? { say: ENGLISH_REPLY } : { say: BENGALI_REPLY }
    );
    const { loop, events } = await start(Loop);
    await loop.send(BENGALI_TYPED_IN_LATIN);

    expect(asked(REPAIR)).toBe(1);
    expect(ends(events)).toHaveLength(1);
  });
});
