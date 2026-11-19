/**
 * The first look through the real session loop and a scripted model: the
 * note rides each send until a send makes something, a first look's answer
 * goes on without a second check, and nothing rides after that.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FIRST_LOOK_GO_ON_PROMPT, FIRST_LOOK_PROMPT } from "./first-look.js";
import type { DesktopEvent } from "./protocol.js";
import { AbacusBotSession } from "./session.js";

let provider: FakeProvider;
let home: string;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "first-look-home-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_FIRST_LOOK = "1";
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider)
  );
});

afterAll(async () => {
  delete process.env.ABACUSAI_BOT_FIRST_LOOK;
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The notes the first request of the latest send carried. */
const carried = (from: number): { look: boolean; goOn: boolean } => {
  const sent = JSON.stringify(provider.calls[from]?.messages ?? []);
  const count = (note: string): number => sent.split(note).length - 1;
  const before = JSON.stringify(provider.calls[from - 1]?.messages ?? []);
  const had = (note: string): number => before.split(note).length - 1;
  return {
    look: count(FIRST_LOOK_PROMPT) > had(FIRST_LOOK_PROMPT),
    goOn: count(FIRST_LOOK_GO_ON_PROMPT) > had(FIRST_LOOK_GO_ON_PROMPT),
  };
};

describe("the first look", () => {
  it("rides until a send makes something, then the answer goes on once", async () => {
    const replies: Reply[] = [
      { say: "12" },
      {
        say: "Here is the first page.",
        call: {
          name: "write",
          args: { path: "page1.html", content: "<h1>Apollo 11</h1>" },
        },
      },
      {
        say: "Is this the right look?",
        call: {
          name: "suggest_tasks",
          args: { tasks: [{ text: "Looks right, keep going" }] },
        },
      },
      { say: "Is this the right look?" },
      { say: "All five pages are done." },
      { say: "Sure." },
    ];
    provider.script(
      (_call, index) => replies[Math.min(index, replies.length - 1)]!
    );
    const events: DesktopEvent[] = [];
    /** Sends so far that told the app the note rode them. */
    const marked = (): number =>
      events.filter(
        (event) => event.type === "event" && event.event.type === "first_look"
      ).length;
    const session = new AbacusBotSession({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "first-look-cwd-")),
      mode: "yolo",
      hostServices: false,
      emit: (event: DesktopEvent) => events.push(event),
    } as never);
    await session.start();

    await session.send("what's 15% of 80");
    expect(carried(0)).toEqual({ look: true, goOn: false });

    const big = provider.calls.length;
    await session.send("Make printable pages for my Apollo 11 trifold");
    expect(carried(big)).toEqual({ look: true, goOn: false });

    const answer = provider.calls.length;
    await session.send("Looks right, keep going");
    expect(carried(answer)).toEqual({ look: false, goOn: true });
    expect(marked()).toBe(2);

    const later = provider.calls.length;
    await session.send("thanks");
    expect(carried(later)).toEqual({ look: false, goOn: false });
    await session.stop();
  }, 60_000);
});
