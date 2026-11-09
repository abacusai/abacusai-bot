/**
 * What the model is told about this app and what chatting costs, as it
 * receives it: the product facts on every plan, the plan's own line, an
 * upgrade mid-chat reaching the next turn, and a note on abacus.ai help pages.
 * A paying user was told chatting is free and given another product's CLI
 * steps as this app's.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeProvider } from "@abacus-ai/test-support/fake-provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planFactsPrompt, setHostAccountPlan } from "./account-plan.js";
import { PRODUCT_FACTS_PROMPT } from "./base-prompt.js";
import { AbacusBotSession } from "./session.js";
import { OTHER_PRODUCT_NOTE, otherProductNote } from "./web/tools.js";

let provider: FakeProvider;
let home: string;
let cwd: string;

/** The system message of the nth request, flattened to text. */
const systemPrompt = (index: number): string => {
  const content = provider.calls[index]?.messages.find(
    (m) => m.role === "system"
  )?.content;
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

beforeEach(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pf-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pf-cwd-"));
  process.env.ABACUSAI_BOT_HOME = home;
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      defaultModel: "probe/m",
      customProviders: [
        {
          id: "probe",
          baseUrl: provider.baseUrl,
          apiKey: "k",
          models: [{ id: "m", contextWindow: 128_000, maxTokens: 4_096 }],
        },
      ],
    })
  );
});

afterEach(async () => {
  setHostAccountPlan({ tier: "unknown", name: null });
  delete process.env.ABACUSAI_BOT_HOME;
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const startSession = async (): Promise<AbacusBotSession> => {
  const agent = new AbacusBotSession({
    cwd,
    mode: "yolo",
    hostServices: false,
    emit: () => {},
  });
  await agent.start();
  return agent;
};

/** What every plan is told: this app's surfaces, not another product's, and credits on every plan. */
const expectProductFacts = (prompt: string): void => {
  expect(prompt).toContain(PRODUCT_FACTS_PROMPT);
  expect(prompt).toMatch(/no CLI to install/);
  expect(prompt).toMatch(/no VS Code extension/);
  expect(prompt).toMatch(/answered from bot_help, never from memory/);
  expect(prompt).toMatch(/credits on every plan, free and paid alike/);
  expect(prompt).toMatch(/never say chatting, this chat .* free/);
};

describe("product and plan facts in the prompt", () => {
  it("tell a paid plan that its chats use its credits", async () => {
    setHostAccountPlan({ tier: "paid", name: "Pro" });
    const agent = await startSession();
    await agent.send("is chatting here free?");
    agent.dispose();

    const prompt = systemPrompt(0);
    expectProductFacts(prompt);
    expect(prompt).toContain(
      "Their Abacus AI plan: Pro (paid). Chats, bots and routines here on Abacus AI models use its credits"
    );
    expect(prompt).not.toMatch(/the free plan\./);
  }, 120_000);

  it("tell the free plan that its credits pay for chats", async () => {
    setHostAccountPlan({ tier: "free", name: "free" });
    const agent = await startSession();
    await agent.send("is chatting here free?");
    agent.dispose();

    const prompt = systemPrompt(0);
    expectProductFacts(prompt);
    expect(prompt).toContain(
      "Their Abacus AI plan: the free plan. Its credits pay for chats"
    );
    expect(prompt).toContain("chatting is not free for them either");
  }, 120_000);

  it("send an unread plan to billing_plan and follow an upgrade into the next turn", async () => {
    const agent = await startSession();
    await agent.send("hi");
    expect(systemPrompt(0)).toContain(
      "plan has not been read yet: call billing_plan"
    );

    // The `account_plan` command after a payment lands.
    setHostAccountPlan({ tier: "basic", name: "Basic" });
    await agent.send("and now?");
    agent.dispose();

    const after = systemPrompt(provider.calls.length - 1);
    expectProductFacts(after);
    expect(after).toContain("Their Abacus AI plan: Basic (paid).");
    expect(after).not.toContain("plan has not been read yet");
  }, 120_000);
});

describe("the plan line", () => {
  it("never calls chatting free on any plan, and an unnamed paid plan still reads paid", () => {
    for (const tier of ["free", "basic", "paid", "unknown"] as const) {
      const line = planFactsPrompt({ tier, name: null });
      expect(line).not.toMatch(/\bis free\b|costs? nothing|free forever/);
    }
    expect(planFactsPrompt({ tier: "paid", name: null })).toContain(
      "a paid plan (paid)"
    );
  });

  it("keeps the last plan when a command is unreadable", () => {
    setHostAccountPlan({ tier: "paid", name: "Pro" });
    setHostAccountPlan(null);
    expect(planFactsPrompt()).toContain("Pro (paid)");
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
