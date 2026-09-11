/**
 * Picking a conversation back up across a restart.
 *
 * The bug this answers: the desktop restored a chat's transcript on screen
 * while the agent behind it started with an empty context, so a bot asked
 * about something said an hour earlier had genuinely never been told.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { conversationSessionManager } from "./session-file.js";

/**
 * One real turn. pi holds a session in memory until an assistant message
 * exists — it will not litter the sessions directory with chats that never
 * got a reply — so a user message alone never reaches disk.
 */
const turn = (
  manager: ReturnType<typeof conversationSessionManager>,
  said: string
): void => {
  const timestamp = 0;
  manager?.appendMessage({ role: "user", content: said, timestamp });
  manager?.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "noted" }],
    timestamp,
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0 },
    stopReason: "stop",
  } as never);
};

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;
const previousId = process.env.ABACUSAI_BOT_SESSION_ID;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-file-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_SESSION_ID = "chat-1";
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  if (previousId == null) delete process.env.ABACUSAI_BOT_SESSION_ID;
  else process.env.ABACUSAI_BOT_SESSION_ID = previousId;
  fs.rmSync(home, { recursive: true, force: true });
});

const fileFor = (id: string): string =>
  path.join(home, "agent", "sessions", "desktop", `${id}.jsonl`);

describe("conversationSessionManager", () => {
  it("uses one file per session id, so a restart finds the same one", () => {
    const first = conversationSessionManager(home);
    expect(first?.getSessionFile()).toBe(fileFor("chat-1"));

    const second = conversationSessionManager(home);
    expect(second?.getSessionFile()).toBe(first?.getSessionFile());
  });

  it("comes back on the same session id, keeping what was written", () => {
    const first = conversationSessionManager(home);
    if (first == null) throw new Error("no manager");
    turn(first, "remember: my cat is Mim");
    const sessionId = first.getSessionId();

    // A new process, same chat.
    const resumed = conversationSessionManager(home);

    expect(resumed?.getSessionId()).toBe(sessionId);
    expect(JSON.stringify(resumed?.getEntries())).toContain("my cat is Mim");
  });

  it("gives a different chat its own history", () => {
    const first = conversationSessionManager(home);
    turn(first, "chat one");

    process.env.ABACUSAI_BOT_SESSION_ID = "chat-2";
    const other = conversationSessionManager(home);

    expect(JSON.stringify(other?.getEntries())).not.toContain("chat one");
  });

  it("starts clean when a reset asks for it, and stays clean after", () => {
    const first = conversationSessionManager(home);
    turn(first, "before the reset");

    const afterReset = conversationSessionManager(home, { fresh: true });
    expect(JSON.stringify(afterReset?.getEntries())).not.toContain(
      "before the reset"
    );
    turn(afterReset, "after the reset");

    // The next restart resumes from the reset, not from before it.
    const restarted = conversationSessionManager(home);
    const entries = JSON.stringify(restarted?.getEntries());
    expect(entries).toContain("after the reset");
    expect(entries).not.toContain("before the reset");
  });

  it("leaves pi to choose when nothing names a session", () => {
    // A one-shot run: a fresh session is the right answer.
    delete process.env.ABACUSAI_BOT_SESSION_ID;

    expect(conversationSessionManager(home)).toBeUndefined();
  });

  it("refuses an id that would escape its directory", () => {
    process.env.ABACUSAI_BOT_SESSION_ID = "../../etc/passwd";

    expect(conversationSessionManager(home)).toBeUndefined();
  });

  it("costs the history, not the chat, when the file is not a session", () => {
    fs.mkdirSync(path.dirname(fileFor("chat-1")), { recursive: true });
    fs.writeFileSync(fileFor("chat-1"), "this is not a pi session\n", "utf8");

    expect(conversationSessionManager(home)).toBeUndefined();
  });
});
