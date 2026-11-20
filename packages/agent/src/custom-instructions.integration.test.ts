/**
 * Standing instructions, as the model actually receives them.
 *
 * The unit tests next door cover the file and the wording. What they cannot
 * show is the part that was asked for: that the block reaches the system
 * prompt, that it sits last, and that editing it lands on the next turn of a
 * conversation already running rather than on the next session.
 *
 * So these read the request body off a loopback endpoint and assert on the
 * system message the provider was sent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeProvider } from "@abacus-ai/test-support/fake-provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BotSession } from "./bot/bot-session.js";
import { writeCustomInstructions } from "./custom-instructions.js";
import { subAgentMemory } from "./memory/chat.js";
import { commit, noteWrite } from "./memory/notes.js";
import { AbacusBotSession } from "./session.js";
import { writeUserLanguage } from "./user-language.js";

let provider: FakeProvider;
let home: string;
let cwd: string;

/** The system message of the nth request, flattened to text. */
const systemPrompt = (index: number): string => {
  const message = provider.calls[index]?.messages.find(
    (m) => m.role === "system"
  );
  const content = message?.content;

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

  home = fs.mkdtempSync(path.join(os.tmpdir(), "ci-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ci-cwd-"));
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
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_LOCALE;
  delete process.env.ABACUSAI_BOT_MEMORY;
  delete process.env.ABACUSAI_BOT_MEMORY_PROJECT;
  delete process.env.ABACUSAI_BOT_BOT_DIR;
  delete process.env.ABACUSAI_BOT_AUDIENCE;
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const session = (): AbacusBotSession =>
  new AbacusBotSession({
    cwd,
    mode: "yolo",
    hostServices: false,
    emit: () => {},
  });

describe("standing instructions in a real turn", () => {
  it("reaches the model, and sits last in the prompt", async () => {
    await writeCustomInstructions("Sign off every answer with SPARROW.");

    const agent = session();

    await agent.start();
    await agent.send("hi");
    agent.dispose();

    const prompt = systemPrompt(0);

    expect(prompt).toContain("Sign off every answer with SPARROW.");
    // Last, so it reads as the user's own word rather than more background.
    // The display guidance is one of the blocks it has to come after.
    expect(prompt.indexOf("SPARROW")).toBeGreaterThan(
      prompt.indexOf("markdown image")
    );
    // Only the reply-language block comes after (it closes every prompt),
    // then pi's own trailer, which it appends below everything the app
    // contributes.
    const after = prompt.slice(prompt.indexOf("SPARROW.") + "SPARROW.".length);

    // pi's trailer is its skills list (when a tool can read them) and the
    // cwd line: nothing else of ours may sit between SPARROW and those.
    expect(after.trim()).toMatch(
      /^## Reply language\n\n[^\n]+\s+(The following skills provide[\s\S]*)?Current working directory:/
    );
  }, 120_000);

  it("picks up an edit on the next turn of the same conversation", async () => {
    // The requirement: not "next session". The user edits the box mid-chat and
    // the very next thing they send is answered under the new instructions.
    await writeCustomInstructions("Answer in French.");

    const agent = session();

    await agent.start();
    await agent.send("one");

    await writeCustomInstructions("Answer in German.");
    await agent.send("two");
    agent.dispose();

    expect(systemPrompt(0)).toContain("Answer in French.");

    const second = systemPrompt(provider.calls.length - 1);

    expect(second).toContain("Answer in German.");
    expect(second).not.toContain("Answer in French.");
  }, 120_000);

  it("leaves the prompt alone when nothing is set", async () => {
    const agent = session();

    await agent.start();
    await agent.send("hi");
    agent.dispose();

    expect(systemPrompt(0)).not.toMatch(/standing instructions/i);
  }, 120_000);
});

const NO_EMOJI = "Never use emojis.";
const FORMAL = "A formal tone, no exclamation marks.";

/** A rule the user wrote and a preference a chat saved for them, About you. */
const seedStanding = async (): Promise<void> => {
  await writeCustomInstructions(NO_EMOJI);
  await commit({ by: "chat" }, () => ({
    writes: [
      noteWrite({
        scope: { kind: "you" },
        name: "formal-tone",
        description: "Formal tone",
        type: "preference",
        body: FORMAL,
        updated: "2026-11-20",
        by: "chat",
      }),
    ],
    value: null,
  }));
};

const ROUTINE_FIRE =
  '[routine] "Daily brief" fired on its schedule.\n\nSend my brief as:\n🌅 Good morning! ☀️\n📅 Today: ...\n✅ Done!';

describe("standing instructions everywhere the bot writes to the user", () => {
  it("reach a routine's run, rules and preferences, ahead of its saved template", async () => {
    await seedStanding();
    process.env.ABACUSAI_BOT_MEMORY = "routine";
    process.env.ABACUSAI_BOT_MEMORY_PROJECT = JSON.stringify({
      kind: "routine",
      key: "job-1",
      name: "Daily brief",
    });

    const agent = session();
    await agent.start();
    await agent.send(ROUTINE_FIRE);
    agent.dispose();

    const prompt = systemPrompt(0);
    expect(prompt).toContain(NO_EMOJI);
    expect(prompt).toContain(FORMAL);
    expect(prompt).toMatch(/routine's saved instruction or\s+report template/);
    // The template's emojis would be copied whatever the prompt says: they go.
    expect(provider.calls[0]!.userText.at(-1)).toBe(
      '[routine] "Daily brief" fired on its schedule.\n\nSend my brief as:\nGood morning! \nToday: ...\nDone!'
    );
    // A sub-agent the run starts writes under the same block.
    expect(subAgentMemory().join("\n")).toContain(FORMAL);
  }, 120_000);

  it("reach a bot's chat with its owner; a ban on emojis takes reactions off the run, once, from the next turn", async () => {
    process.env.ABACUSAI_BOT_BOT_DIR = path.join(home, "bot");
    fs.mkdirSync(process.env.ABACUSAI_BOT_BOT_DIR);
    process.env.ABACUSAI_BOT_AUDIENCE = "owner";

    const bot = new BotSession({
      cwd,
      mode: "yolo",
      hostServices: false,
      emit: () => {},
    } as never);
    await bot.start();
    await bot.send("Thank you, that was great work!");
    await bot.send("And another thing.");
    await seedStanding();
    await bot.send("Thanks again!");
    await bot.send("One more.");

    const reacts = (index: number): boolean =>
      provider.calls[index]!.tools.includes("react_to_message");
    // Before the rule: the tool and its guidance are there, and nothing moves.
    expect(reacts(0) && reacts(1)).toBe(true);
    expect(systemPrompt(0)).toContain("react_to_message");
    expect(systemPrompt(1)).toBe(systemPrompt(0));
    // After it: the block arrives, the tool and every word of it go, and stay gone.
    const last = provider.calls.length - 1;
    const prompt = systemPrompt(last);
    expect(prompt).toContain(NO_EMOJI);
    expect(prompt).toContain(FORMAL);
    expect(prompt).toMatch(/routine's saved instruction/);
    expect(prompt).not.toContain("react_to_message");
    expect(reacts(last) || reacts(last - 1)).toBe(false);
    expect(systemPrompt(last - 1)).toBe(prompt);
  }, 120_000);

  it("give someone else's chat the rules but never the user's preferences", async () => {
    await seedStanding();
    process.env.ABACUSAI_BOT_MEMORY = "sender";

    const agent = session();
    await agent.start();
    await agent.send("hi");
    agent.dispose();

    const prompt = systemPrompt(0);
    expect(prompt).toContain(NO_EMOJI);
    expect(prompt).not.toContain(FORMAL);
  }, 120_000);

  it("pick up a preference changed mid-chat on the next turn, and say it once", async () => {
    const agent = session();
    await agent.start();
    await agent.send("one");
    await seedStanding();
    await agent.send("two");
    agent.dispose();

    const second = provider.calls.at(-1)!;
    expect(systemPrompt(provider.calls.length - 1)).toContain(FORMAL);
    // Not announced again as a memory change: the block already carries it.
    expect(JSON.stringify(second.messages.slice(1))).not.toContain(FORMAL);
  }, 120_000);
});

describe("the reply-language block in a real conversation", () => {
  const block = (prompt: string): string =>
    prompt.slice(prompt.indexOf("## Reply language")).split("\n")[2] ?? "";

  it("falls back to the app's language, and stays byte-identical across turns in mixed languages", async () => {
    process.env.ABACUSAI_BOT_LOCALE = "tr-TR";
    const agent = session();

    await agent.start();
    for (const text of [
      "merhaba, bugün neler var?",
      "ok",
      "and in English: what is on my calendar?",
      "¿y mañana?",
      "https://example.com",
      "teşekkürler",
    ])
      await agent.send(text);
    agent.dispose();

    const first = systemPrompt(0);
    expect(block(first)).toContain("The user's language is Turkish.");
    expect(block(first)).toContain("the user's latest message");
    for (let index = 1; index < provider.calls.length; index++)
      expect(systemPrompt(index)).toBe(first);
  }, 120_000);

  it("changes exactly once when a language is first saved, at the next turn", async () => {
    process.env.ABACUSAI_BOT_LOCALE = "pt-BR";
    const agent = session();

    await agent.start();
    await agent.send("oi");
    await agent.send("tudo bem?");
    writeUserLanguage("Spanish", "detected");
    await agent.send("hola");
    await agent.send("gracias");
    agent.dispose();

    const prompts = provider.calls.map((_call, index) => systemPrompt(index));
    expect(new Set(prompts).size).toBe(2);
    expect(block(prompts[0]!)).toContain(
      "The user's language is Brazilian Portuguese."
    );
    expect(block(prompts.at(-1)!)).toContain("The user's language is Spanish.");
    // One change, between the second turn and the third: never back.
    const changes = prompts.filter(
      (prompt, index) => index > 0 && prompt !== prompts[index - 1]
    );
    expect(changes).toHaveLength(1);
  }, 120_000);

  it("falls back to English, not Hindi, on a Hindi OS", async () => {
    process.env.ABACUSAI_BOT_LOCALE = "hi-IN";
    const agent = session();

    await agent.start();
    await agent.send("hello");
    agent.dispose();

    expect(block(systemPrompt(0))).toContain("The user's language is English.");
    expect(systemPrompt(0)).not.toMatch(/language is Hindi|reply in Hindi/);
  }, 120_000);
});
