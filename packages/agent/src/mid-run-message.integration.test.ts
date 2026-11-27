/**
 * A message the user sends while a run works reaches the model with the note
 * to answer it at once, on both loops; an answer to the model's own question
 * does not.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  conversationOf,
  FakeProvider,
  fakeProviderConfig,
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

import { BotSession } from "./bot/bot-session.js";
import { midRunMessageNote } from "./mid-run-message.js";
import { AbacusBotSession } from "./session.js";

let provider: FakeProvider;
let home: string;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mid-run-home-"));
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
});

type Loop = {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  steer(
    text: string,
    messageId?: string,
    options?: { answer?: boolean }
  ): Promise<void>;
  dispose?(): void;
};

const LOOPS: Array<[string, new (options: never) => Loop]> = [
  ["the session loop", AbacusBotSession as never],
  ["the bot loop", BotSession as never],
];

describe.each(LOOPS)("%s", (_name, Loop) => {
  const run = async (steer: (loop: Loop) => Promise<void>) => {
    const loop = new Loop({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mid-run-cwd-")),
      mode: "yolo",
      hostServices: false,
      emit: () => {},
    } as never);
    await loop.start();
    let steered = false;
    provider.script(async (_call, index) => {
      if (index === 0) {
        if (!steered) {
          steered = true;
          await steer(loop);
        }
        return { call: { name: "ls", args: { path: "." } } };
      }
      if (index === 1) return { call: { name: "ls", args: { path: ".." } } };
      return { say: "Done." };
    });
    await loop.send("install the project");
    loop.dispose?.();
    return provider.calls.map(conversationOf);
  };

  it("hands a message sent mid-run to the model with the note to answer it now", async () => {
    const calls = await run((loop) => loop.steer("is it nearly done?"));
    const second = calls[1] ?? "";
    expect(second).toContain("is it nearly done?");
    expect(second).toContain(midRunMessageNote());
    expect(second.indexOf("is it nearly done?")).toBeLessThan(
      second.indexOf(midRunMessageNote())
    );
    // Only the request that brought the message carries the note.
    expect(calls[2] ?? "").not.toContain(midRunMessageNote());
  });

  it("adds no note to a message that was dropped from the run and sent as its own turn", async () => {
    const loop = new Loop({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "mid-run-cwd-")),
      mode: "yolo",
      hostServices: false,
      emit: () => {},
    } as never);
    await loop.start();
    let steered = false;
    provider.script(async (_call, index) => {
      if (index === 0 && !steered) {
        steered = true;
        await loop.steer("and add a dark mode");
        (loop as unknown as { dropSteers(): void }).dropSteers();
        return { say: "Done." };
      }
      return { say: "Dark mode added." };
    });
    await loop.send("build the page");
    await loop.send("and add a dark mode");
    loop.dispose?.();
    expect(provider.calls.map(conversationOf).join("\n")).not.toContain(
      midRunMessageNote()
    );
  });

  it("adds no note to the answer of the model's own question", async () => {
    const calls = await run((loop) =>
      loop.steer('{"Which one?":"the first"}', undefined, { answer: true })
    );
    expect(calls.join("\n")).toContain("the first");
    expect(calls.join("\n")).not.toContain(midRunMessageNote());
  });
});
