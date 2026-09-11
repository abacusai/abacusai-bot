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

const session = (): AbacusBotSession =>
  new AbacusBotSession({
    cwd,
    mode: "yolo",
    hostServices: false,
    emit: () => {},
  });

describe("standing instructions in a real turn", () => {
  it("reaches the model, and sits last in the prompt", async () => {
    writeCustomInstructions("Sign off every answer with SPARROW.");

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
    // Nothing of ours comes after: what follows is pi's own trailer, which it
    // appends below everything the app contributes.
    const after = prompt.slice(prompt.indexOf("SPARROW.") + "SPARROW.".length);

    // pi's trailer is its skills list (when a tool can read them) and the
    // cwd line — nothing of ours may sit between SPARROW and those.
    expect(after.trim()).toMatch(
      /^(The following skills provide[\s\S]*)?Current working directory:/
    );
  }, 120_000);

  it("picks up an edit on the next turn of the same conversation", async () => {
    // The requirement: not "next session". The user edits the box mid-chat and
    // the very next thing they send is answered under the new instructions.
    writeCustomInstructions("Answer in French.");

    const agent = session();

    await agent.start();
    await agent.send("one");

    writeCustomInstructions("Answer in German.");
    await agent.send("two");
    agent.dispose();

    expect(systemPrompt(0)).toContain("Answer in French.");

    const second = systemPrompt(sent.length - 1);

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
