/**
 * What the composer's up-arrow remembers.
 *
 * Two rules carry this file. The list is capped, because the arrows are for
 * "the thing I just asked, again, slightly different" and not for searching.
 * And a prompt sent twice appears once, at the front. A run of identical
 * entries is only further to press.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home = "";
vi.mock("../../paths", () => ({ abacusBotHome: () => home }));

const { addPromptToHistory, readPromptHistory, PROMPT_HISTORY_LIMIT } =
  await import("./prompt-history");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("recording prompts", () => {
  it("keeps each session's history to itself", () => {
    // Up-arrow in one bot's chat used to walk every other chat's prompts:
    // one flat list per profile. A prompt belongs to the box it left from.
    addPromptToHistory("bot-a", "summarize my inbox");
    addPromptToHistory("session-b", "run the tests");

    expect(readPromptHistory("bot-a")).toEqual(["summarize my inbox"]);
    expect(readPromptHistory("session-b")).toEqual(["run the tests"]);
    expect(readPromptHistory("never-used")).toEqual([]);
  });

  it("has nothing to offer before anything is sent", () => {
    expect(readPromptHistory("s1")).toEqual([]);
  });

  it("keeps the newest first", () => {
    addPromptToHistory("s1", "first");
    addPromptToHistory("s1", "second");

    expect(readPromptHistory("s1")).toEqual(["second", "first"]);
  });

  it("keeps the last twenty and no more", () => {
    for (let i = 0; i < PROMPT_HISTORY_LIMIT + 5; i += 1) {
      addPromptToHistory("s1", `prompt ${i}`);
    }

    const history = readPromptHistory("s1");
    expect(history).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(history[0]).toBe(`prompt ${PROMPT_HISTORY_LIMIT + 4}`);
    expect(history).not.toContain("prompt 0");
  });

  it("moves a repeated prompt to the front rather than duplicating it", () => {
    addPromptToHistory("s1", "run the tests");
    addPromptToHistory("s1", "something else");
    addPromptToHistory("s1", "run the tests");

    expect(readPromptHistory("s1")).toEqual([
      "run the tests",
      "something else",
    ]);
  });

  it("ignores whitespace-only sends", () => {
    addPromptToHistory("s1", "   ");
    addPromptToHistory("s1", "\n");

    expect(readPromptHistory("s1")).toEqual([]);
  });

  it("trims what it stores", () => {
    addPromptToHistory("s1", "  padded  ");

    expect(readPromptHistory("s1")).toEqual(["padded"]);
  });

  it("survives a file that is not what it expects", () => {
    fs.writeFileSync(path.join(home, "prompt-history.json"), "not json");

    expect(readPromptHistory("s1")).toEqual([]);
    expect(addPromptToHistory("s1", "after")).toEqual(["after"]);
  });

  it("keeps each profile's history to itself", () => {
    // The per-profile guarantee, and the reason this lives beside the agent's
    // config rather than in the renderer's localStorage: switching accounts
    // repoints this directory, so the next user's arrows show their own
    // prompts. localStorage does not switch, and would have leaked.
    addPromptToHistory("s1", "ada's prompt");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-"));
    const ada = home;
    home = other;

    expect(readPromptHistory("s1")).toEqual([]);

    home = ada;
    expect(readPromptHistory("s1")).toEqual(["ada's prompt"]);
    fs.rmSync(other, { recursive: true, force: true });
  });
});
