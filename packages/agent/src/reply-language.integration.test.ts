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
import { loadLanguageModel } from "./language-id.js";
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
const VIETNAMESE_QUESTION =
  "Bạn có thể giúp tôi viết một đoạn mã nhỏ để quản lý danh sách khách hàng không?";
const VIETNAMESE_REPLY =
  "Được, tôi đã viết một đoạn mã nhỏ lưu danh sách khách hàng vào tệp, có thể thêm, tìm và xóa từng mục.";
const ENGLISH_CODE_REPLY =
  "Sure, I wrote a small script that keeps your customer list in a file and lets you add, search and remove entries.";
const ENGLISH_REQUEST =
  "Make a short video about a city where every road disappears for five seconds.";
const HUNGARIAN_REPLY =
  "Szívesen, a videóhoz először kiválasztom a stílust és a hosszt, aztán megírom a jeleneteket egyenként.";
const STEER = "You just wrote to the person in";
const systemOf = (index: number): string =>
  JSON.stringify(provider.calls[index]?.messages[0] ?? "");

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
  beforeEach(async () => {
    await loadLanguageModel();
  });

  it("asks once for an English reply to Vietnamese words, one script apart from nothing", async () => {
    scripted((last) =>
      last.includes(REPAIR)
        ? { say: VIETNAMESE_REPLY }
        : { say: ENGLISH_CODE_REPLY }
    );
    const { loop, events } = await start(Loop);
    await loop.send(VIETNAMESE_QUESTION);

    expect(asked(REPAIR)).toBe(1);
    expect(provider.calls).toHaveLength(2);
    expect(ends(events)).toHaveLength(1);
    expect(idle(events)).toBe(true);
  });

  it("names the user's language in the prompt of the turn they first wrote in, and repairs a reply in the app's", async () => {
    process.env.ABACUSAI_BOT_LOCALE = "hu-HU";
    scripted((last) =>
      last.includes(REPAIR)
        ? { say: "Sure, here is the plan for the video, scene by scene." }
        : { say: HUNGARIAN_REPLY }
    );
    try {
      const { loop, events } = await start(Loop);
      await loop.send(ENGLISH_REQUEST);

      expect(
        JSON.parse(
          fs.readFileSync(path.join(home, "user-language.json"), "utf8")
        )
      ).toMatchObject({
        language: { name: "English", source: "detected" },
      });
      expect(systemOf(0)).toContain("The user's language is English");
      expect(asked(REPAIR)).toBe(1);
      expect(ends(events)).toHaveLength(1);
    } finally {
      delete process.env.ABACUSAI_BOT_LOCALE;
    }
  });

  it("judges a first run against the language the user's goal was in", async () => {
    fs.writeFileSync(
      path.join(home, "user-language.json"),
      JSON.stringify({
        language: { name: "Vietnamese", source: "detected" },
        version: 2,
      })
    );
    scripted((last) =>
      last.includes(REPAIR)
        ? { say: VIETNAMESE_REPLY }
        : { say: ENGLISH_CODE_REPLY }
    );
    const { loop, events } = await start(Loop);
    await loop.send(
      '[first run] Introduce yourself once, then take the first step toward what the user asked for: "toi muon cai tien code".'
    );

    expect(asked(REPAIR)).toBe(1);
    expect(ends(events)).toHaveLength(1);
  });

  it("steers the run back once when a progress note drifts, and leaves a reply in their language alone", async () => {
    scripted((_last, index) =>
      index === 0
        ? {
            say: "Let me check the folder first and then write the script for your customer list.",
            call: {
              name: "write",
              args: { path: "customers.py", content: "customers = []" },
            },
          }
        : { say: VIETNAMESE_REPLY }
    );
    const { loop, events } = await start(Loop);
    await loop.send(VIETNAMESE_QUESTION);

    const steered = provider.calls.filter((call) =>
      call.userText.some((text) => text.includes(STEER))
    );
    expect(steered.length).toBeGreaterThan(0);
    expect(asked(REPAIR)).toBe(0);
    expect(ends(events)).toHaveLength(1);
    expect(idle(events)).toBe(true);
  });

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

  // Tasks are handed only to a bot's own chat, the bot loop.
  it.runIf(Loop === (BotSession as never))(
    "asks no next step after a task the app handed the bot: its report goes back to the asker",
    async () => {
      process.env.ABACUSAI_BOT_NEXT_STEP_ASK = "1";
      scripted((last, index) =>
        index === 0
          ? {
              say: "",
              call: {
                name: "write",
                args: { path: "checklist.md", content: "1. Lease" },
              },
            }
          : { say: "Saved checklist.md: 1. Lease." }
      );
      const { loop, events } = await start(Loop);
      await (loop as unknown as BotSession).send(
        "[task from the user, passed on by Writer] Write the checklist.",
        { userText: { operator: { kind: "bot-task" } } } as never
      );

      expect(asked(NEXT_STEP_PROMPT.slice(0, 40))).toBe(0);
      expect(ends(events)).toHaveLength(1);
    }
  );

  it("asks only for the buttons when a result's reply already ends on its own question", async () => {
    process.env.ABACUSAI_BOT_NEXT_STEP_ASK = "1";
    const BUTTONS_ONLY = "Your reply ends on a question";
    scripted((last, index) =>
      last.includes(BUTTONS_ONLY)
        ? { say: "" }
        : index === 0
          ? {
              say: "",
              call: {
                name: "write",
                args: { path: "site.html", content: "<h1>Your Name</h1>" },
              },
            }
          : { say: "The page is ready. Want me to put your real name in?" }
    );
    const { loop, events } = await start(Loop);
    await loop.send("Build me a one-page site");

    expect(asked(BUTTONS_ONLY)).toBe(1);
    expect(asked("The work above is done")).toBe(0);
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
