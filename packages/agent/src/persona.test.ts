import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planFactsPrompt } from "./account-plan.js";
import {
  PROGRESS_UPDATES_PROMPT,
  ATTACHMENTS_PROMPT,
  ASKED_FOR_PROMPT,
  CONNECTION_PROMPT,
  DELIVERABLE_QUALITY_PROMPT,
  MEDIA_ASKS_PROMPT,
  PRODUCT_FACTS_PROMPT,
  FACTS_PROMPT,
  USER_DATA_PROMPT,
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
const previousRemote = process.env.ABACUSAI_BOT_REMOTE_SENDER;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-persona-"));
  // The prompt differs in a remote sender's chat: start every case as the owner's.
  delete process.env.ABACUSAI_BOT_REMOTE_SENDER;
});

afterEach(() => {
  if (previousEnv == null) delete process.env.ABACUSAI_BOT_PERSONA;
  else process.env.ABACUSAI_BOT_PERSONA = previousEnv;
  if (previousRemote == null) delete process.env.ABACUSAI_BOT_REMOTE_SENDER;
  else process.env.ABACUSAI_BOT_REMOTE_SENDER = previousRemote;

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
   * right after who the agent is, fixed for the life of a session, so the
   * cached prefix never changes.
   */
  it("go to bot_help, in one fixed line after the identity block", () => {
    for (const edit of ["ours", "builtin"] as const) {
      const prompt = basePrompt(edit);
      expect(
        prompt.startsWith(
          `${identityPrompt()}\n${PRODUCT_FACTS_PROMPT}\n${PROGRESS_UPDATES_PROMPT}\n${MEDIA_ASKS_PROMPT}\n${PLAN_ASKS_PROMPT}\n${USER_DATA_PROMPT}\n${FACTS_PROMPT}\n${DELIVERABLE_QUALITY_PROMPT}\n${ATTACHMENTS_PROMPT}\n${CONNECTION_PROMPT}\n${ASKED_FOR_PROMPT}\n\n`
        )
      ).toBe(true);
      expect(basePrompt(edit)).toBe(prompt);
    }
    expect(PRODUCT_FACTS_PROMPT).toContain(
      "bot_help, never from memory or a web page"
    );
    // A long turn's updates ride with a tool call: a text-only message ends the turn.
    expect(PROGRESS_UPDATES_PROMPT).toMatch(
      /in the same message as your next tool call/
    );
    // When to call paid_feature is the tool's word (the free plan plans first);
    // a call still comes before any words, so no reply opens on a refusal.
    expect(MEDIA_ASKS_PROMPT).toMatch(
      /paid_feature: its description says when to call it\. When you call it, call it before you write anything/
    );
    expect(MEDIA_ASKS_PROMPT).not.toMatch(/call it first/);
    // A file is done when it opens; data is sourced or called sample; a long job counts.
    expect(DELIVERABLE_QUALITY_PROMPT).toMatch(
      /done only when it opens and nothing is left broken/
    );
    expect(DELIVERABLE_QUALITY_PROMPT).toMatch(/it is sample data/);
    // One owner for facts: a file's data points at the facts rule, not a copy of it.
    expect(DELIVERABLE_QUALITY_PROMPT).toMatch(/follow the facts rule above/);
    expect(DELIVERABLE_QUALITY_PROMPT).not.toMatch(/invented data/i);
    // The user's data keeps its owner; asked to decide, it decides; facts are sourced.
    expect(USER_DATA_PROMPT).toMatch(/applies to the whole block/);
    expect(USER_DATA_PROMPT).toMatch(/assign or decide, decide/);
    expect(USER_DATA_PROMPT).toMatch(
      /their own messages and files from the first/
    );
    expect(FACTS_PROMPT).toMatch(/Never present invented data as real/);
    expect(FACTS_PROMPT).toMatch(/not from the web/);
    expect(DELIVERABLE_QUALITY_PROMPT).toMatch(/count done against total/);
    // A file said to be attached but missing is asked for again, never stood in for.
    expect(ATTACHMENTS_PROMPT).toMatch(/`@<path>` lines/);
    expect(ATTACHMENTS_PROMPT).toMatch(/attach it again/);
  });

  /**
   * A remote sender's chat answers for the user and defers what is theirs to
   * decide, so the owner's data rules (decide, ask) stay out of it.
   */
  it("leave the user-data block out of a remote sender's chat", () => {
    expect(basePrompt("builtin")).toContain(USER_DATA_PROMPT);
    process.env.ABACUSAI_BOT_REMOTE_SENDER = "1";
    expect(basePrompt("builtin")).not.toContain(USER_DATA_PROMPT);
    expect(basePrompt("builtin")).toContain(FACTS_PROMPT);
  });

  /** Channel turns and bot asks are sender chats the user reads: they keep it. */
  it("keep the user-data block in any other sender chat", () => {
    const previous = process.env.ABACUSAI_BOT_SENDER_CHAT;
    try {
      process.env.ABACUSAI_BOT_SENDER_CHAT = "1";
      expect(basePrompt("builtin")).toContain(USER_DATA_PROMPT);
    } finally {
      if (previous == null) delete process.env.ABACUSAI_BOT_SENDER_CHAT;
      else process.env.ABACUSAI_BOT_SENDER_CHAT = previous;
    }
  });

  /**
   * Answered from memory, "does it run with my PC off?" got a flat no and
   * "put it online" got free hosts and tunnels: both go to billing_plan.
   */
  it("send 'keep working with the computer off' and 'put it online' to billing_plan, free part first, never another company's service", () => {
    expect(PLAN_ASKS_PROMPT).toMatch(/computer is off or asleep/);
    expect(PLAN_ASKS_PROMPT).toMatch(
      /a live link that stays up for a site of several pages/
    );
    // One file needs no plan: Share, without a billing_plan call.
    expect(PLAN_ASKS_PROMPT).toMatch(
      /that needs no plan: do not call billing_plan/
    );
    expect(PLAN_ASKS_PROMPT).toMatch(/press Share/);
    expect(PLAN_ASKS_PROMPT).toMatch(
      /call billing_plan with upgrade: true before you answer/
    );
    expect(PLAN_ASKS_PROMPT).toMatch(/Say the free part first/);
    expect(PLAN_ASKS_PROMPT).toMatch(/every feature it gives as a short list/);
    expect(PLAN_ASKS_PROMPT).toMatch(
      /never send them to another company's service for it/
    );
  });

  /**
   * Asked for free alternatives with the free credits nearly gone, the model
   * named other AI products and packaged the project to move there.
   */
  it("sends a free account's asks for something free or cheaper to billing_plan, never a paid one's, and never to other AI products", () => {
    const ask =
      /When the user \(never a contact you reply to for them\) asks for something free or cheaper \(more free credits, a free or cheaper way to keep going, a free alternative to this app\), or says their credits are low or gone: call billing_plan with upgrade: true and ask: "cheaper" before you answer, and answer from it, the free ways first \(a model the model menu lists as free runs without credits, and so does a model on a provider key of their own\), never hiding one/;
    const free = planFactsPrompt({ tier: "free", name: null });
    expect(free).toMatch(ask);
    expect(free).toMatch(
      /Never recommend other AI products or apps in place of this one, compare them, or help move their work to one/
    );
    expect(free).toMatch(/their files are theirs, in their folder/);
    // A paid account's ask is not a plan pitch; the fixed prompt stays the same for every plan.
    for (const tier of ["basic", "paid", "unknown"] as const)
      expect(planFactsPrompt({ tier, name: null })).not.toMatch(ask);
    expect(PLAN_ASKS_PROMPT).not.toMatch(/free or cheaper/);
  });

  it("is not a sub-agent's: it has no bot_help", () => {
    expect(subAgentBasePrompt(true)).not.toContain("bot_help");
    expect(subAgentBasePrompt(false)).not.toContain("bot_help");
  });
});
