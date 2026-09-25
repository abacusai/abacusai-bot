/**
 * How large an output budget a request actually asks for.
 *
 * Not a unit test on the clamp, because the clamp is not the interesting part:
 * what matters is the number that reaches the provider, and that is decided
 * further down: pi sends `min(model.maxTokens, contextWindow - prompt)`. So
 * these read the request body off a loopback endpoint and assert on the field
 * the provider's credit check reads.
 *
 * The bug: a model's `maxTokens` is what it *can* emit, and asking for all of
 * it every turn is not free even though the tokens are never generated.
 * OpenRouter prices the ceiling you authorise, so `deepseek-v4-flash` (384,000
 * output tokens at $0.1652/M) needed $0.063 of credit behind every request,
 * "say hi" included. Keys holding a couple of cents got HTTP 402 on a turn that
 * would have cost a fraction of one, and the failure read as the model being
 * unavailable.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MAX_OUTPUT_TOKENS } from "./providers.js";
import { AbacusBotSession } from "./session.js";

/** An endpoint that answers once and keeps what it was asked for. */
function endpoint(): {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
  ready: Promise<void>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if ((request.url ?? "").endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "m" }] }));

        return;
      }

      bodies.push(JSON.parse(body || "{}") as Record<string, unknown>);
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
  let port = 0;
  const ready = new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    })
  );

  return {
    get url() {
      return `http://127.0.0.1:${port}/v1`;
    },
    bodies,
    ready,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const homes: string[] = [];

/** The budget the first request asked for, against a model of this shape. */
async function budgetAskedFor(model: {
  contextWindow: number;
  maxTokens: number;
  maxOutputTokens?: number;
}): Promise<number | undefined> {
  const server = endpoint();

  await server.ready;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "budget-home-"));

  homes.push(home);
  process.env.ABACUSAI_BOT_HOME = home;
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      defaultModel: "probe/m",
      ...(model.maxOutputTokens != null
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      customProviders: [
        {
          id: "probe",
          baseUrl: server.url,
          apiKey: "k",
          models: [
            {
              id: "m",
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            },
          ],
        },
      ],
    })
  );

  const session = new AbacusBotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "budget-cwd-")),
    mode: "yolo",
    hostServices: false,
    emit: () => {},
  });

  await session.start();
  await session.send("hi");
  session.dispose();
  await server.close();

  const first = server.bodies[0] ?? {};

  return (first.max_completion_tokens ?? first.max_tokens) as
    | number
    | undefined;
}

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  while (homes.length > 0)
    fs.rmSync(homes.pop() as string, { recursive: true, force: true });
});

describe("the output budget a request asks for", () => {
  it("does not ask for a model's whole advertised maximum", async () => {
    // deepseek-v4-flash's real shape. Unclamped this asked for 383,014 tokens,
    // which OpenRouter will only run for a key holding $0.063, per request.
    expect(
      await budgetAskedFor({ contextWindow: 1_048_576, maxTokens: 384_000 })
    ).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  }, 120_000);

  it("leaves a model that asks for less alone", async () => {
    // The ceiling is a cap, not a target: nothing is inflated to meet it.
    expect(
      await budgetAskedFor({ contextWindow: 163_840, maxTokens: 8_192 })
    ).toBe(8_192);
  }, 120_000);

  it("honours a ceiling raised in config", async () => {
    // For someone who really does want a long answer and has the credit for it.
    expect(
      await budgetAskedFor({
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        maxOutputTokens: 64_000,
      })
    ).toBe(64_000);
  }, 120_000);
});
