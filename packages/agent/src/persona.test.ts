import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEDIA_ASKS_PROMPT,
  PRODUCT_FACTS_PROMPT,
  basePrompt,
  subAgentBasePrompt,
} from "./base-prompt.js";
import {
  identityPrompt,
  MAX_PERSONA,
  personaPrompt,
  readPersona,
} from "./persona.js";
import { PLAN_ASKS_PROMPT } from "./plan-asks.js";

let dir: string;
const previousEnv = process.env.ABACUSAI_BOT_PERSONA;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-persona-"));
});

afterEach(() => {
  if (previousEnv == null) delete process.env.ABACUSAI_BOT_PERSONA;
  else process.env.ABACUSAI_BOT_PERSONA = previousEnv;

  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a session that is not a bot's chat", () => {
  it("has no persona", () => {
    delete process.env.ABACUSAI_BOT_PERSONA;

    expect(readPersona()).toBe("");
    expect(personaPrompt()).toBeNull();
  });

  it("survives a persona path that does not exist", () => {
    process.env.ABACUSAI_BOT_PERSONA = path.join(dir, "missing.md");

    expect(personaPrompt()).toBeNull();
  });
});

describe("a bot's chat", () => {
  it("frames the persona rather than pasting it raw", () => {
    const file = path.join(dir, "persona.md");
    fs.writeFileSync(file, "# Scout\nWatch the news.\n");
    process.env.ABACUSAI_BOT_PERSONA = file;

    const prompt = personaPrompt();

    expect(prompt).toContain("# Scout");
    expect(prompt).toContain("named bot's own chat");
    // Identity must not read as permission.
    expect(prompt).toContain("permission mode still");
  });

  it("bounds a runaway persona file", () => {
    const file = path.join(dir, "persona.md");
    fs.writeFileSync(file, "x".repeat(MAX_PERSONA * 2));
    process.env.ABACUSAI_BOT_PERSONA = file;

    expect(readPersona().length).toBe(MAX_PERSONA);
  });
});

describe("who the agent says it is", () => {
  it("is AbacusAI Bot, whatever model the turn ran on", () => {
    // The reported case: asked "which model are you?", a distilled model
    // under the router introduced itself as another vendor's assistant.
    const identity = identityPrompt();

    expect(identity).toMatch(/^You are AbacusAI Bot, here to help the user/);
    expect(identity).toMatch(/never introduce yourself as another assistant/);
  });
});

describe("questions about the app itself", () => {
  /**
   * From memory the model said routines run on a server and that outside
   * models cannot be added; bot_help reads the app instead. One fixed line
   * right after who the agent is, the same for every session, so the cached
   * prefix never changes.
   */
  it("go to bot_help, in one fixed line after the identity block", () => {
    for (const edit of ["ours", "builtin"] as const) {
      const prompt = basePrompt(edit);
      expect(
        prompt.startsWith(
          `${identityPrompt()}\n${PRODUCT_FACTS_PROMPT}\n${MEDIA_ASKS_PROMPT}\n${PLAN_ASKS_PROMPT}\n\n`
        )
      ).toBe(true);
      expect(basePrompt(edit)).toBe(prompt);
    }
    expect(PRODUCT_FACTS_PROMPT).toContain(
      "bot_help, never from memory or a web page"
    );
    // A media ask calls paid_feature before any words, so the reply opens with the plan.
    expect(MEDIA_ASKS_PROMPT).toMatch(
      /paid_feature: call it first, before you write anything/
    );
  });

  /**
   * Answered from memory, "does it run with my PC off?" got a flat no and
   * "put it online" got free hosts and tunnels: both go to billing_plan.
   */
  it("send 'keep working with the computer off' and 'put it online' to billing_plan, free part first, never another company's service", () => {
    expect(PLAN_ASKS_PROMPT).toMatch(/computer is off or asleep/);
    expect(PLAN_ASKS_PROMPT).toMatch(
      /a live, public or shareable link for something they built/
    );
    expect(PLAN_ASKS_PROMPT).toMatch(
      /call billing_plan with upgrade: true before you answer/
    );
    expect(PLAN_ASKS_PROMPT).toMatch(/Say the free part first/);
    expect(PLAN_ASKS_PROMPT).toMatch(/every feature it gives as a short list/);
    expect(PLAN_ASKS_PROMPT).toMatch(
      /never send them to another company's service for it/
    );
  });

  it("is not a sub-agent's: it has no bot_help", () => {
    expect(subAgentBasePrompt(true)).not.toContain("bot_help");
    expect(subAgentBasePrompt(false)).not.toContain("bot_help");
  });
});
