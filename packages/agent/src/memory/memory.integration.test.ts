/**
 * Memory as the model receives it, read off the requests a real session
 * sends: the block in the system prompt, nothing at all with the switch off,
 * the save check when an asked-for save did not happen, and a change made
 * elsewhere arriving as a hidden line while the system prompt stays the same.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeProvider } from "@abacus-ai/test-support/fake-provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AbacusBotSession } from "../session.js";

let provider: FakeProvider;
let home: string;
let cwd: string;
const saved = { ...process.env };

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part != null && typeof part === "object" && "text" in part
              ? String((part as { text: unknown }).text)
              : ""
          )
          .join("")
      : JSON.stringify(content ?? "");

const systemPrompt = (index: number): string =>
  text(
    provider.calls[index]?.messages.find((m) => m.role === "system")?.content
  );

const allText = (index: number): string =>
  (provider.calls[index]?.messages ?? [])
    .map((m) => text(m.content))
    .join("\n");

const toolNames = (index: number): string[] =>
  (
    (provider.calls[index]?.body.tools as
      | Array<{ function?: { name?: string } }>
      | undefined) ?? []
  ).map((tool) => tool.function?.name ?? "");

beforeEach(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mem-cwd-"));
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
  const memories = path.join(home, "memories");
  fs.mkdirSync(memories, { recursive: true });
  fs.writeFileSync(
    path.join(memories, "REMEMBER.md"),
    "Answer in British English"
  );
});

afterEach(async () => {
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const session = () =>
  new AbacusBotSession({
    cwd,
    mode: "yolo",
    hostServices: false,
    emit: () => {},
  });

describe("memory in a real session", () => {
  it("puts the user's rules in the prompt and gives the model the memory tool", async () => {
    const agent = session();
    await agent.start();
    await agent.send("hi");
    agent.dispose();

    expect(systemPrompt(0)).toContain("Answer in British English");
    expect(toolNames(0)).toContain("memory");
  }, 120_000);

  it("has no memory at all when the switch is off", async () => {
    process.env.ABACUSAI_BOT_MEMORY = "off";
    const agent = session();
    await agent.start();
    await agent.send("hi");
    agent.dispose();

    expect(systemPrompt(0)).not.toContain("Answer in British English");
    expect(systemPrompt(0)).not.toContain("How to use memory");
    expect(toolNames(0)).not.toContain("memory");
  }, 120_000);

  it("asks once more when the user asked to remember and nothing was saved", async () => {
    provider.scriptSequence([{ say: "Got it, saved!" }, { say: "Saved now." }]);
    const agent = session();
    await agent.start();
    await agent.send("remember that my shop closes on Mondays");
    agent.dispose();

    expect(provider.calls.length).toBe(2);
    expect(allText(1)).toContain("nothing was saved this turn");
  }, 120_000);

  it("tells a running chat about a change made elsewhere without touching its prompt", async () => {
    const agent = session();
    await agent.start();
    await agent.send("one");

    // Another process (the Memory page, another chat) saves a preference: its file
    // and its history line, which is how processes see each other's changes.
    const note = [
      "---",
      "name: sign-as-sam",
      "description: Sign every email as Sam.",
      "type: preference",
      "updated: 2026-11-09",
      "by: you",
      "---",
      "",
      "Sign every email as Sam.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(home, "memory", "you", "sign-as-sam.md"), note);
    const history = path.join(home, "memory", ".history");
    const month = fs.readdirSync(history).sort().pop()!;
    fs.appendFileSync(
      path.join(history, month),
      `${JSON.stringify({ at: new Date().toISOString(), by: "you", session: "memory-page", path: "you/sign-as-sam.md", before: null, after: note })}\n`
    );

    await agent.send("two");
    agent.dispose();

    const last = provider.calls.length - 1;
    expect(systemPrompt(last)).toBe(systemPrompt(0));
    expect(allText(last)).toContain("Sign every email as Sam.");
  }, 120_000);
});
