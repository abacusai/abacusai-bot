/**
 * An unattended run's system prompt, as the model receives it: none of the
 * user's private context (memory, profile, remember notes, standing
 * instructions, the folder's AGENTS.md and skills), so a page the run reads
 * cannot ask for it back. An attended session gets all of it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeProvider } from "@abacus-ai/test-support/fake-provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCustomInstructions } from "./custom-instructions.js";
import { AbacusBotSession } from "./session.js";

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
  await provider.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const MARKS = [
  "MEMORY-MARK",
  "PROFILE-MARK",
  "REMEMBER-MARK",
  "INSTRUCTIONS-MARK",
  "AGENTS-MARK",
  "SKILL-MARK",
];

const seed = async (): Promise<void> => {
  const memories = path.join(home, "memories");
  fs.mkdirSync(memories, { recursive: true });
  fs.writeFileSync(path.join(memories, "MEMORY.md"), "MEMORY-MARK");
  fs.writeFileSync(path.join(memories, "REMEMBER.md"), "REMEMBER-MARK");
  fs.writeFileSync(
    path.join(home, "account.json"),
    JSON.stringify({ account: { username: "Alex PROFILE-MARK" } })
  );
  await writeCustomInstructions("INSTRUCTIONS-MARK");
  fs.writeFileSync(path.join(cwd, "AGENTS.md"), "AGENTS-MARK");
  const skill = path.join(cwd, ".abacusai-bot", "skills", "demo");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: demo\ndescription: SKILL-MARK\n---\nBody.\n"
  );
};

const promptFor = async (
  mode: string,
  unattended?: { sources: string[]; watchUrl: null }
): Promise<string> => {
  const agent = new AbacusBotSession({
    cwd,
    mode,
    hostServices: false,
    emit: () => {},
    ...(unattended != null ? { unattended } : {}),
  });
  await agent.start();
  await agent.send("hi");
  agent.dispose();
  return systemPrompt(provider.calls.length - 1);
};

describe("an unattended run's prompt", () => {
  it("carries none of the user's private context", async () => {
    await seed();
    const attended = await promptFor("yolo");
    // The fixture works: an attended session gets every mark.
    for (const mark of MARKS) expect(attended, mark).toContain(mark);

    const unattended = await promptFor("unattended", {
      sources: [],
      watchUrl: null,
    });
    expect(unattended.length).toBeGreaterThan(0);
    for (const mark of MARKS) expect(unattended, mark).not.toContain(mark);
  }, 120_000);
});
