/**
 * A model that restates its note before a second tool call, through the real
 * session loop: the user sees the first note, the new finding and the reply,
 * not the restatement, and the model's own history keeps every word it wrote.
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

import type { DesktopEvent } from "./protocol.js";
import { AbacusBotSession } from "./session.js";

const NOTE = "Checking both files to find where the date column comes from.";
const RESTATED = "Opening both files to find where the date column comes from.";
const FINDING = "Found it: column D subtracts the wrong year.";
const REPLY = "Fixed: column D now uses the order year.";

let provider: FakeProvider;
let home: string;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "repeated-notes-home-"));
  process.env.ABACUSAI_BOT_HOME = home;
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider)
  );
});

afterAll(async () => {
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const echo = (word: string) => ({
  name: "bash",
  args: { command: `echo ${word}` },
});

describe("a restated note", () => {
  it("is not shown, and stays in the model's history", async () => {
    const replies: Reply[] = [
      { say: NOTE, call: echo("one") },
      { say: RESTATED, call: echo("two") },
      { say: FINDING, call: echo("three") },
      { say: REPLY },
    ];
    provider.script(
      (_call, index) => replies[Math.min(index, replies.length - 1)]!
    );
    const events: DesktopEvent[] = [];
    const session = new AbacusBotSession({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "repeated-notes-cwd-")),
      mode: "yolo",
      hostServices: false,
      emit: (event: DesktopEvent) => events.push(event),
    } as never);
    await session.start();
    await session.send("why is the date column wrong?");
    await session.stop();

    const shown = events
      .flatMap((event) => (event.type === "event" ? [event.event] : []))
      .map((event) => (event.type === "text_delta" ? event.content : ""))
      .join("");
    expect(shown).toBe(NOTE + FINDING + REPLY);
    expect(JSON.stringify(provider.calls.at(-1)!.body.messages)).toContain(
      RESTATED
    );
  }, 60_000);
});
