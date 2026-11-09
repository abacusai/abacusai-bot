/**
 * What the model is told about this app and what chatting costs, as it
 * receives it: the product facts on every plan, the plan's own line as the
 * desktop sends it (at spawn and by command, in a chat and in a bot's chat),
 * and a note on abacus.ai help pages.
 * A paying user was told chatting is free and given another product's CLI
 * steps as this app's.
 */
import * as path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { planFactsPrompt, setHostAccountPlan } from "./account-plan.js";
import { GOLDEN_ROOT, stopProvider } from "./agui/__tests__/harness.js";
import { live, runInput } from "./agui/__tests__/live.js";
import { PRODUCT_FACTS_PROMPT } from "./base-prompt.js";
import { OTHER_PRODUCT_NOTE, otherProductNote } from "./web/tools.js";

const BOT_DIR = path.join(GOLDEN_ROOT, "home", "bots", "bot-1");

afterEach(() => {
  setHostAccountPlan({ tier: "unknown", name: null });
});

afterAll(async () => {
  await stopProvider();
});

/** What every plan is told: this app's surfaces, not another product's, and credits on every plan. */
const expectProductFacts = (prompt: string): void => {
  expect(prompt).toContain(PRODUCT_FACTS_PROMPT);
  expect(prompt).toMatch(/no CLI to install/);
  expect(prompt).toMatch(/no VS Code extension/);
  expect(prompt).toMatch(/answered from bot_help, never from memory/);
  expect(prompt).toMatch(/credits on every plan, free and paid alike/);
  expect(prompt).toMatch(/never say chatting, this chat .* free/);
};

/** The system message the model got on a recorded call. */
const systemOf = (
  call: { messages: Array<{ role: string; content?: unknown }> } | undefined
): string => {
  const content = call?.messages.find((m) => m.role === "system")?.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part != null && typeof part === "object" && "text" in part
              ? String((part as { text: unknown }).text)
              : ""
          )
          .join("")
      : "";
};

/** One turn per plan, the plan sent as the desktop sends it: the `account_plan` command. */
const promptsFor = async (
  plans: Array<Record<string, unknown> | null>,
  options: Parameters<typeof live>[0]
): Promise<string[]> => {
  const l = await live(options);
  try {
    for (const [index, next] of plans.entries()) {
      if (next != null) l.send({ type: "account_plan", ...next });
      l.send(runInput(`r${index}`, "is chatting here free?"));
      await l.waitFor(
        (all) =>
          all.filter((event) => event.type === "RUN_FINISHED").length > index,
        `run ${index}`
      );
    }
    // A bot's own hidden turns are not the user's; its first call is.
    return l.calls().map(systemOf);
  } finally {
    await l.close();
  }
};

describe("product and plan facts reach the model through the account_plan command", () => {
  it("in a chat: free, then a payment moves it to a paid plan mid-chat", async () => {
    const prompts = await promptsFor(
      [
        { tier: "free", name: "Free" },
        { tier: "basic", name: "Basic" },
      ],
      { reply: () => ({ say: "ok" }) }
    );
    const [free, paid] = [prompts[0]!, prompts.at(-1)!];
    expectProductFacts(free);
    expect(free).toContain(
      "The user's Abacus AI plan (theirs, never something to tell a contact you reply to for them): the free plan. Chats, bots and routines on Abacus AI models use its credits."
    );
    expectProductFacts(paid);
    expect(paid).toContain(
      ": Basic, a paid plan. Chats, bots and routines on Abacus AI models use its credits."
    );
    expect(paid).not.toContain("the free plan.");
    // After the static blocks, so a plan change keeps them cached.
    expect(paid.indexOf("a paid plan.")).toBeGreaterThan(
      paid.indexOf(PRODUCT_FACTS_PROMPT)
    );
  }, 120_000);

  it("in a bot's chat, worded as the owner's plan, never a contact's", async () => {
    const prompts = await promptsFor([{ tier: "paid", name: "Pro" }], {
      realSessionChoice: true,
      env: { ABACUSAI_BOT_BOT_DIR: BOT_DIR, PI_OFFLINE: "1" },
      reply: (index) =>
        index === 0 ? { say: "<reply>ok</reply>" } : { say: "NO_REPLY" },
    });
    const prompt = prompts[0]!;
    expectProductFacts(prompt);
    expect(prompt).toContain(
      "never something to tell a contact you reply to for them): Pro, a paid plan."
    );
  }, 120_000);

  it("sends an unread plan to billing_plan", async () => {
    const [prompt] = await promptsFor([null], { reply: () => ({ say: "ok" }) });
    expect(prompt).toContain("has not been read yet: call billing_plan");
  }, 120_000);
});

describe("the plan at spawn", () => {
  it("is read from ABACUSAI_BOT_PLAN, and an unreadable one is an unread plan", async () => {
    vi.resetModules();
    vi.stubEnv(
      "ABACUSAI_BOT_PLAN",
      JSON.stringify({ tier: "free", name: "Free" })
    );
    expect((await import("./account-plan.js")).planFactsPrompt()).toContain(
      ": the free plan."
    );
    vi.resetModules();
    vi.stubEnv("ABACUSAI_BOT_PLAN", "{not json");
    expect((await import("./account-plan.js")).planFactsPrompt()).toContain(
      "has not been read yet"
    );
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("the plan line", () => {
  it("never calls chatting free on any plan, and an unnamed paid plan still reads paid", () => {
    for (const tier of ["free", "basic", "paid", "unknown"] as const) {
      const line = planFactsPrompt({ tier, name: null });
      expect(line).not.toMatch(/\bis free\b|costs? nothing|free forever/);
    }
    expect(planFactsPrompt({ tier: "paid", name: null })).toContain(
      "them): a paid plan. Chats"
    );
  });

  it("keeps the last plan when a command is unreadable", () => {
    setHostAccountPlan({ tier: "paid", name: "Pro" });
    setHostAccountPlan(null);
    expect(planFactsPrompt()).toContain("Pro, a paid plan");
    setHostAccountPlan({ tier: "gold", name: "  " });
    expect(planFactsPrompt()).toContain("has not been read yet");
  });
});

describe("abacus.ai help pages", () => {
  it("carry a note that they are another product's and point to bot_help", () => {
    expect(
      otherProductNote([
        "https://abacus.ai/help/abacusai-desktop/providers",
      ]).trim()
    ).toBe(OTHER_PRODUCT_NOTE);
    expect(otherProductNote(["https://www.abacus.ai/help"])).not.toBe("");
    expect(OTHER_PRODUCT_NOTE).toMatch(/call bot_help/);
  });

  it("leave every other page alone, this app's own site included", () => {
    expect(
      otherProductNote([
        "https://bot.abacus.ai/",
        "https://abacus.ai/helpful",
        "https://example.com/help/abacus",
        "web search results",
      ])
    ).toBe("");
  });
});
