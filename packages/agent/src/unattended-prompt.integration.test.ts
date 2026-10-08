/**
 * An unattended run's system prompt, as the model receives it: none of the
 * user's private context (memory, profile, remember notes, standing
 * instructions, the folder's AGENTS.md and skills), so a page the run reads
 * cannot ask for it back. An attended session gets all of it.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCustomInstructions } from "./custom-instructions.js";
import { AbacusBotSession } from "./session.js";

interface Sent {
  messages?: Array<{ role: string; content: unknown }>;
}

const sent: Sent[] = [];
let server: http.Server;
let port = 0;
let home: string;
let cwd: string;

/** The system message of the nth request, flattened to text. */
const systemPrompt = (index: number): string => {
  const message = sent[index]?.messages?.find((m) => m.role === "system");
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
  sent.length = 0;
  server = http.createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if ((request.url ?? "").endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "m" }] }));

        return;
      }

      sent.push(JSON.parse(body || "{}") as Sent);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  port = (server.address() as AddressInfo).port;

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
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "k",
          models: [{ id: "m", contextWindow: 128_000, maxTokens: 4_096 }],
        },
      ],
    })
  );
});

afterEach(async () => {
  delete process.env.ABACUSAI_BOT_HOME;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

const seed = (): void => {
  const memories = path.join(home, "memories");
  fs.mkdirSync(memories, { recursive: true });
  fs.writeFileSync(path.join(memories, "MEMORY.md"), "MEMORY-MARK");
  fs.writeFileSync(path.join(memories, "REMEMBER.md"), "REMEMBER-MARK");
  fs.writeFileSync(
    path.join(home, "account.json"),
    JSON.stringify({ account: { username: "Alex PROFILE-MARK" } })
  );
  writeCustomInstructions("INSTRUCTIONS-MARK");
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
  return systemPrompt(sent.length - 1);
};

describe("an unattended run's prompt", () => {
  it("carries none of the user's private context", async () => {
    seed();
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
