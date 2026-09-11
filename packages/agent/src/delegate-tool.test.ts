/**
 * Whether a session gets `delegate_task`. A bot never does: a delegate starts
 * blank, so the bot re-describes its own state to it and gets that wrong —
 * one routine handed a delegate a spill id as a file path, and the delegate's
 * "neither file exists" landed in the user's chat as the bot's own words.
 */
import { afterEach, describe, expect, it } from "vitest";

import { delegationEnabled } from "./delegate-tool.js";

afterEach(() => {
  delete process.env.ABACUSAI_BOT_BOT_DIR;
  delete process.env.ABACUSAI_BOT_EXCLUDED_TOOLS;
});

describe("delegate_task", () => {
  it("is on for an ordinary chat session", () => {
    expect(delegationEnabled()).toBe(true);
  });

  it("is off when the desktop switched the toolset off", () => {
    process.env.ABACUSAI_BOT_EXCLUDED_TOOLS = "web_search, delegate_task";
    expect(delegationEnabled()).toBe(false);
  });

  it("is always off for a bot, routines included", () => {
    process.env.ABACUSAI_BOT_BOT_DIR = "/home/x/.abacusai-bot/bots/chief";
    expect(delegationEnabled()).toBe(false);
  });
});
